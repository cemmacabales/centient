// #203 — POST /api/me/event-code: the labeler's side of an event code.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gamification/server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { POST } from "@/app/api/me/event-code/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { createEventCode } from "@/lib/gamification/redeem";
import { manilaDayKey, addDays } from "@/lib/gamification/time";
import { truncateAll } from "@/tests/helpers/db";
import { createAdminUser, createUser } from "@/tests/helpers/factories";

let userId: string;

beforeEach(async () => {
  await truncateAll();
  userId = (await createUser()).id;
  const admin = await createAdminUser();
  const today = manilaDayKey();
  await createEventCode(admin.id, {
    code: "WEBINAR1",
    stampTitle: "Contributor webinar",
    stampIcon: "podcasts",
    startsDay: addDays(today, -1),
    endsDay: addDays(today, 1),
  });
  await createEventCode(admin.id, {
    code: "BQF2026",
    stampTitle: "BlockQuest Fiesta",
    stampIcon: "festival",
    startsDay: addDays(today, -10),
    endsDay: addDays(today, -8),
  });
});

async function post(body: unknown, as: string | null = userId) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.cookie = `labeler_session=${await signLabelerJWT(as)}`;
  const res = await POST(new NextRequest("http://localhost/api/me/event-code", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe("POST /api/me/event-code", () => {
  it("needs a session", async () => {
    expect(await post({ code: "WEBINAR1" }, null)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  });

  it("redeems a code and returns its stamp and the XP", async () => {
    const res = await post({ code: "webinar1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: "WEBINAR1", stamp: { title: "Contributor webinar", icon: "podcasts" }, xp: 25, xpTotal: 25 });
    expect(res.body).not.toHaveProperty("ok");
  });

  it("refuses a second redemption", async () => {
    await post({ code: "WEBINAR1" });
    expect(await post({ code: "WEBINAR1" })).toMatchObject({ status: 409, body: { error: "already_redeemed" } });
  });

  it("refuses a code whose days are over", async () => {
    expect(await post({ code: "BQF2026" })).toMatchObject({ status: 409, body: { error: "ended" } });
  });

  it("says an unknown code is unknown, and a bad body is too", async () => {
    expect(await post({ code: "NOPE1234" })).toMatchObject({ status: 404, body: { error: "unknown_code" } });
    expect(await post({})).toMatchObject({ status: 404, body: { error: "unknown_code" } });
  });

  it("asks a wallet-less account to sign in with a wallet", async () => {
    const emailOnly = (await createUser({ walletAddress: null, email: "x@y.co" })).id;
    expect(await post({ code: "WEBINAR1" }, emailOnly)).toMatchObject({ status: 409, body: { error: "wallet_required" } });
  });

  it("refuses a banned account", async () => {
    const banned = (await createUser({ isBanned: true, bannedUntil: new Date(Date.now() + 3600_000) })).id;
    expect(await post({ code: "WEBINAR1" }, banned)).toMatchObject({ status: 403, body: { error: "banned" } });
  });

  it("slows guessing down with a Retry-After", async () => {
    for (let i = 0; i < 10; i++) await post({ code: `GUESS${i}` });
    const res = await post({ code: "WEBINAR1" });
    expect(res).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
