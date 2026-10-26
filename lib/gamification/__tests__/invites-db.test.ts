// #203 — invites against a real database: captured only when the invitee's
// account is created, paid once when the invitee first reaches Skilled, to both
// sides, with the inviter capped at 10 and invite XP kept off the board.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";
import { captureServer } from "../server-analytics";
import { attachInviter, inviteCodeFor, qualifyInvite, readInvite } from "../invites";
import { updateStanding } from "../standing";
import { weekEntries } from "../leaderboard";
import { manilaWeekKey } from "../time";

let inviter: string;
let invitee: string;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(captureServer).mockReset();
  inviter = (await createUser()).id;
  invitee = (await createUser()).id;
});

const user = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
const stampsOf = async (id: string) => (await prisma.userStamp.findMany({ where: { userId: id } })).map((s) => s.stampId).sort();
const events = (name: string) => vi.mocked(captureServer).mock.calls.filter((c) => c[1] === name);

async function invited(by = inviter) {
  const id = (await createUser()).id;
  expect(await attachInviter(id, await inviteCodeFor(by))).toBe(true);
  return id;
}

async function reachSkilled(id: string) {
  await prisma.user.update({ where: { id }, data: { xp: { increment: 250 } } });
  return updateStanding(id, "answer");
}

describe("inviteCodeFor", () => {
  it("makes a code once and keeps it", async () => {
    const code = await inviteCodeFor(inviter);
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(await inviteCodeFor(inviter)).toBe(code);
    expect((await user(inviter)).inviteCode).toBe(code);
  });
});

describe("attachInviter", () => {
  it("records who invited a new account, case-insensitively", async () => {
    const code = await inviteCodeFor(inviter);
    expect(await attachInviter(invitee, code.toLowerCase())).toBe(true);
    expect((await user(invitee)).invitedById).toBe(inviter);
  });

  it("refuses a self-invite, an unknown code, and a second inviter", async () => {
    expect(await attachInviter(inviter, await inviteCodeFor(inviter))).toBe(false);
    expect(await attachInviter(invitee, "ZZZZ2345")).toBe(false);
    const other = (await createUser()).id;
    await attachInviter(invitee, await inviteCodeFor(inviter));
    expect(await attachInviter(invitee, await inviteCodeFor(other))).toBe(false);
    expect((await user(invitee)).invitedById).toBe(inviter);
  });
});

describe("qualifying on Skilled", () => {
  it("pays both sides 50 XP and a stamp when the invitee first reaches Skilled, once", async () => {
    const friend = await invited();
    const first = await reachSkilled(friend);
    expect(first.tierUp).toBe(1);

    expect((await user(friend)).xp).toBe(250 + 50);
    expect((await user(inviter)).xp).toBe(50);
    expect(await stampsOf(friend)).toContain("invited-in");
    expect(await stampsOf(inviter)).toEqual(["brought-a-friend"]);
    expect(await prisma.xpEvent.findMany({ where: { kind: "INVITE" }, orderBy: { dedupeKey: "asc" } })).toMatchObject([
      { userId: friend, amount: 50, dedupeKey: `invite:${friend}:invitee` },
      { userId: inviter, amount: 50, dedupeKey: `invite:${friend}:inviter` },
    ]);
    expect(events("invite_qualified")).toEqual([[friend, "invite_qualified", { inviter_rewarded: true }]]);

    await updateStanding(friend, "answer");
    await qualifyInvite(friend);
    expect(await prisma.xpEvent.count({ where: { kind: "INVITE" } })).toBe(2);
    expect(events("invite_qualified")).toHaveLength(1);
  });

  it("pays nothing before Skilled, or to an account nobody invited", async () => {
    const friend = await invited();
    await prisma.user.update({ where: { id: friend }, data: { xp: 100 } });
    await updateStanding(friend, "answer");
    await reachSkilled(invitee);
    expect(await prisma.inviteReward.count()).toBe(0);
    expect(await prisma.xpEvent.count({ where: { kind: "INVITE" } })).toBe(0);
  });

  it("pays once when qualification races", async () => {
    const friend = await invited();
    await prisma.user.update({ where: { id: friend }, data: { xp: 250, tier: 1 } });
    await Promise.all([qualifyInvite(friend), qualifyInvite(friend), qualifyInvite(friend)]);
    expect(await prisma.inviteReward.count()).toBe(1);
    expect((await user(inviter)).xp).toBe(50);
    expect((await user(friend)).xp).toBe(300);
  });

  it(`stops paying the inviter after 10, and still pays the friend`, async () => {
    for (let i = 0; i < 10; i++) await reachSkilled(await invited());
    expect((await user(inviter)).xp).toBe(500);

    const eleventh = await invited();
    await reachSkilled(eleventh);
    expect((await user(inviter)).xp).toBe(500);
    expect((await user(eleventh)).xp).toBe(300);
    expect(await prisma.inviteReward.findUniqueOrThrow({ where: { inviteeId: eleventh } })).toMatchObject({ inviterRewarded: false });
    expect(await readInvite(inviter)).toMatchObject({ qualified: 10, cap: 10 });
  });

  it("keeps invite XP off the board; it still counts toward tiers", async () => {
    const friend = await invited();
    await reachSkilled(friend);
    expect(await weekEntries(manilaWeekKey())).toEqual([]);
  });
});
