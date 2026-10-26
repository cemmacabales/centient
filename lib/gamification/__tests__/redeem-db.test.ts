// #203 — event codes against a real database: one stamp and 25 XP per account,
// only inside the code's Manila days, never for a banned or wallet-less account,
// wrong guesses slowed down, and a double tap redeeming once.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { prisma, truncateAll } from "@/tests/helpers/db";
import { createAdminUser, createUser } from "@/tests/helpers/factories";
import { captureServer } from "../server-analytics";
import { createEventCode, listEventCodes, redeemEventCode } from "../redeem";
import { EVENT_CODE_XP, EVENT_RULES, eventStampId } from "../events";

// Thursday 15 Oct 2026, 21:00 Manila: the first contributor webinar.
const DURING = new Date("2026-10-15T13:00:00Z");

let adminId: string;
let userId: string;
let codeId: string;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(captureServer).mockReset();
  adminId = (await createAdminUser()).id;
  userId = (await createUser()).id;
  const created = await createEventCode(adminId, {
    code: "WEBINAR1",
    stampTitle: "Contributor webinar",
    stampIcon: "podcasts",
    startsDay: "2026-10-15",
    endsDay: "2026-10-16",
  });
  if (!created.ok) throw new Error("setup");
  codeId = created.code.id;
});

const xpRows = () => prisma.xpEvent.findMany({ where: { userId } });
const stamps = () => prisma.userStamp.findMany({ where: { userId } });

describe("redeemEventCode", () => {
  it("gives the code's own stamp and 25 XP, in this Manila week, and says so once", async () => {
    const res = await redeemEventCode(userId, "webinar1", DURING);
    expect(res).toMatchObject({
      ok: true,
      code: "WEBINAR1",
      stamp: { id: eventStampId(codeId), title: "Contributor webinar", icon: "podcasts" },
      xp: EVENT_CODE_XP,
      xpTotal: EVENT_CODE_XP,
    });

    expect(await xpRows()).toMatchObject([
      { kind: "EVENT_CODE", amount: 25, dedupeKey: `event:${codeId}:${userId}`, dayKey: "2026-10-15", weekKey: "2026-10-12" },
    ]);
    expect((await stamps()).map((s) => s.stampId)).toEqual([eventStampId(codeId)]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).xp).toBe(25);
    expect(vi.mocked(captureServer).mock.calls).toEqual([
      [userId, "event_code_redeemed", { code: "WEBINAR1", xp: 25 }],
      [userId, "stamp_awarded", { stamp: eventStampId(codeId) }],
    ]);
  });

  it("can't be redeemed twice by one account", async () => {
    await redeemEventCode(userId, "WEBINAR1", DURING);
    expect(await redeemEventCode(userId, "WEBINAR1", DURING)).toEqual({ ok: false, error: "already_redeemed" });
    expect(await xpRows()).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).xp).toBe(25);
    expect(captureServer).toHaveBeenCalledTimes(2);
  });

  it("redeems once under a concurrent double tap: one stamp, one 25 XP", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => redeemEventCode(userId, "WEBINAR1", DURING)));
    expect(results.filter((r) => r?.ok)).toHaveLength(1);
    expect(results.filter((r) => !r?.ok).map((r) => r && !r.ok && r.error)).toEqual(Array(4).fill("already_redeemed"));
    expect(await xpRows()).toHaveLength(1);
    expect(await stamps()).toHaveLength(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).xp).toBe(25);
  });

  it("is open on the first and last Manila day, and closed either side", async () => {
    // 23:59 Manila on Wed 14 Oct, and 00:00 on Sat 17 Oct.
    expect(await redeemEventCode(userId, "WEBINAR1", new Date("2026-10-14T15:59:00Z"))).toEqual({
      ok: false,
      error: "not_open",
    });
    expect(await redeemEventCode(userId, "WEBINAR1", new Date("2026-10-16T16:00:00Z"))).toEqual({
      ok: false,
      error: "ended",
    });
    expect(await xpRows()).toEqual([]);
    // 00:00 Thursday and 23:59 Friday, Manila.
    expect(await redeemEventCode(userId, "WEBINAR1", new Date("2026-10-14T16:00:00Z"))).toMatchObject({ ok: true });
    const other = (await createUser()).id;
    expect(await redeemEventCode(other, "WEBINAR1", new Date("2026-10-16T15:59:00Z"))).toMatchObject({ ok: true });
  });

  it("needs a signed-in Stellar wallet", async () => {
    const emailOnly = (await createUser({ walletAddress: null, email: "a@b.co" })).id;
    expect(await redeemEventCode(emailOnly, "WEBINAR1", DURING)).toEqual({ ok: false, error: "wallet_required" });
    const legacy = (await createUser({ walletAddress: "0x" + "a".repeat(40) })).id;
    expect(await redeemEventCode(legacy, "WEBINAR1", DURING)).toEqual({ ok: false, error: "wallet_required" });
  });

  it("is refused while banned, in cooldown or retest", async () => {
    const cooling = (await createUser({ isBanned: true, bannedUntil: new Date(DURING.getTime() + 3600_000) })).id;
    const retest = (await createUser({ isBanned: true, bannedUntil: new Date(DURING.getTime() - 3600_000) })).id;
    for (const id of [cooling, retest]) {
      expect(await redeemEventCode(id, "WEBINAR1", DURING)).toEqual({ ok: false, error: "banned" });
    }
    expect(await prisma.xpEvent.count()).toBe(0);
  });

  it("says a wrong or malformed code is unknown, and gives nothing", async () => {
    expect(await redeemEventCode(userId, "WEBINAR9", DURING)).toEqual({ ok: false, error: "unknown_code" });
    expect(await redeemEventCode(userId, "no", DURING)).toEqual({ ok: false, error: "unknown_code" });
    expect(await xpRows()).toEqual([]);
  });

  it(`slows down guessing after ${EVENT_RULES.guesses.max} tries an hour`, async () => {
    for (let i = 0; i < EVENT_RULES.guesses.max; i++) {
      expect(await redeemEventCode(userId, `GUESS${i}`, DURING)).toEqual({ ok: false, error: "unknown_code" });
    }
    const limited = await redeemEventCode(userId, "WEBINAR1", DURING);
    expect(limited).toMatchObject({ ok: false, error: "rate_limited" });
    expect(await xpRows()).toEqual([]);
    // Another labeler isn't slowed by it.
    const other = (await createUser()).id;
    expect(await redeemEventCode(other, "WEBINAR1", DURING)).toMatchObject({ ok: true });
  });
});

describe("createEventCode", () => {
  it("stores the code uppercase, with the admin who made it", async () => {
    const row = await prisma.eventCode.findUniqueOrThrow({ where: { id: codeId } });
    expect(row).toMatchObject({ code: "WEBINAR1", createdByAdminId: adminId, startsDay: "2026-10-15", endsDay: "2026-10-16" });
  });

  it("refuses a code that exists, whatever its case", async () => {
    const again = await createEventCode(adminId, {
      code: "WEBINAR1",
      stampTitle: "Again",
      stampIcon: "star",
      startsDay: "2026-10-20",
      endsDay: "2026-10-20",
    });
    expect(again).toEqual({ ok: false, error: "code_taken" });
  });

  it("lists codes newest first with how many accounts redeemed each", async () => {
    await redeemEventCode(userId, "WEBINAR1", DURING);
    await redeemEventCode((await createUser()).id, "WEBINAR1", DURING);
    await createEventCode(adminId, {
      code: "WEBINAR2",
      stampTitle: "Contributor webinar 2",
      stampIcon: "podcasts",
      startsDay: "2026-10-22",
      endsDay: "2026-10-23",
    });
    const list = await listEventCodes();
    expect(list.map((c) => [c.code, c.redeemed])).toEqual([
      ["WEBINAR2", 0],
      ["WEBINAR1", 2],
    ]);
  });
});
