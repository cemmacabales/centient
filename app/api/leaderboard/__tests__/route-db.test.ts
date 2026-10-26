// #203 — GET /api/leaderboard: the week's board as the labeler's browser sees
// it. The raw body never carries a hidden name, a wallet, an id or earnings.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gamification/server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { GET } from "@/app/api/leaderboard/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { manilaDayKey, manilaWeekKey } from "@/lib/gamification/time";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

let seq = 0;

beforeEach(async () => {
  await truncateAll();
});

async function xp(userId: string, amount: number) {
  await prisma.xpEvent.create({
    data: { userId, kind: "ANSWER", amount, dedupeKey: `t:${++seq}`, dayKey: manilaDayKey(), weekKey: manilaWeekKey() },
  });
}

async function getAs(userId: string | null) {
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = `labeler_session=${await signLabelerJWT(userId)}`;
  const res = await GET(new NextRequest("http://localhost/api/leaderboard", { headers }));
  return { status: res.status, raw: await res.text() };
}

describe("GET /api/leaderboard", () => {
  it("needs a session", async () => {
    expect((await getAs(null)).status).toBe(401);
  });

  it("never leaks a hidden name, a wallet, an id or earnings", async () => {
    const shown = await createUser({ pendingBalanceUnits: 123_456_789n });
    const optedOut = await createUser();
    const hidden = await createUser();
    await prisma.user.update({ where: { id: shown.id }, data: { displayName: "migs.dela", showOnBoard: true, totalEarnedUnits: 987_654_321n } });
    await prisma.user.update({ where: { id: optedOut.id }, data: { displayName: "quiet.one", showOnBoard: false } });
    await prisma.user.update({
      where: { id: hidden.id },
      data: { displayName: "rude.name", showOnBoard: true, displayNameHiddenAt: new Date() },
    });
    for (const [u, n] of [[shown, 300], [optedOut, 200], [hidden, 100]] as const) await xp(u.id, n);

    const viewer = await createUser();
    const { status, raw } = await getAs(viewer.id);
    expect(status).toBe(200);

    const body = JSON.parse(raw);
    expect(body.rows.map((r: { name: string | null }) => r.name)).toEqual(["migs.dela", null, null]);
    for (const secret of ["quiet.one", "rude.name"]) expect(raw).not.toContain(secret);
    for (const u of [shown, optedOut, hidden, viewer]) {
      expect(raw).not.toContain(u.id);
      expect(raw).not.toContain(u.walletAddress);
    }
    expect(raw).not.toMatch(/units|earn|balance|payout|wallet|usdc|userId/i);
    expect(raw).not.toContain("123456789");
    expect(raw).not.toContain("987654321");
  });
});
