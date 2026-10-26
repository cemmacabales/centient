// #202 — tiers at submit: the labeler's tier snapshot on every row, retest
// checks marked so the floors leave them out, a failed check that holds a
// tier, the tier-up reported on the answer that opened it, and gating that
// refuses a task the labeler wouldn't be served.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", async () => ({
  checkWalletRateLimit: vi.fn(async () => false),
  isLoginRateLimited: vi.fn(async () => false),
  recordLoginFailure: vi.fn(async () => {}),
  resetLoginFailures: vi.fn(async () => {}),
}));
vi.mock("@/lib/quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quality")>();
  return { ...actual, checkReasonRepetition: vi.fn(async () => ({ isRepetitive: false })) };
});
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return { ...actual, accountHasUsdcTrustline: vi.fn(async () => true) };
});
vi.mock("@/lib/gamification/server-analytics", () => ({ captureStanding: vi.fn() }));

import { POST } from "@/app/api/submit/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createCampaign,
  createCampaignBalance,
  createGoldTask,
  createTask,
  createUser,
  VALID_REASON,
} from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function submit(userId: string, taskId: string, choice: "A" | "B") {
  const res = await POST(
    new NextRequest("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `labeler_session=${await signLabelerJWT(userId)}` },
      body: JSON.stringify({ taskId, choice, reason: VALID_REASON }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function labeler(data: { tier?: number; xp?: number; tierOnHold?: boolean; holdChecksPassed?: number } = {}) {
  const user = await createUser();
  await prisma.user.update({ where: { id: user.id }, data });
  return user.id;
}

/** Past checks, oldest first, so the floor has history to read. */
async function history(userId: string, verdicts: boolean[]) {
  for (const [i, passed] of verdicts.entries()) {
    const task = await createGoldTask("A");
    await prisma.submission.create({
      data: {
        userId,
        taskId: task.id,
        choice: passed ? "A" : "B",
        reason: VALID_REASON,
        isGoldCheck: true,
        goldPassed: passed,
        payoutAmountUnits: 0n,
        payoutStatus: "skipped",
        createdAt: new Date(Date.UTC(2026, 9, 1) + i * 1000),
      },
    });
  }
}

const row = (userId: string, taskId: string) =>
  prisma.submission.findUniqueOrThrow({ where: { userId_taskId: { userId, taskId } } });

describe("POST /api/submit - labeler tier snapshot (#202)", () => {
  it("records the tier on an accepted answer", async () => {
    const userId = await labeler({ tier: 2 });
    const task = await createTask({ difficulty: 6 });
    expect((await submit(userId, task.id, "A")).body.status).toBe("pending");
    expect((await row(userId, task.id)).labelerTier).toBe(2);
  });

  it("records it on a quality check, passed or failed", async () => {
    const userId = await labeler({ tier: 1 });
    const pass = await createGoldTask("A");
    const fail = await createGoldTask("A");
    await submit(userId, pass.id, "A");
    await submit(userId, fail.id, "B");
    expect((await row(userId, pass.id)).labelerTier).toBe(1);
    expect((await row(userId, fail.id)).labelerTier).toBe(1);
  });
});

describe("POST /api/submit - retest checks (#202)", () => {
  it("marks a retest check, so the tier floors leave it out", async () => {
    const user = await createUser({ isBanned: true, bannedUntil: new Date(Date.now() - 1000), banCount: 1 });
    const task = await createGoldTask("A");
    await submit(user.id, task.id, "B");
    expect(await row(user.id, task.id)).toMatchObject({ retest: true, isGoldCheck: true, goldPassed: false });
  });

  it("leaves an ordinary check unmarked", async () => {
    const userId = await labeler();
    const task = await createGoldTask("A");
    await submit(userId, task.id, "A");
    expect((await row(userId, task.id)).retest).toBe(false);
  });
});

describe("POST /api/submit - holds (#202)", () => {
  it("holds Skilled when a failed check leaves the last 10 under 80%", async () => {
    const userId = await labeler({ tier: 1, xp: 400 });
    await history(userId, [true, true, true, true, true, true, true, false, false]);
    const task = await createGoldTask("A");

    const res = await submit(userId, task.id, "B");
    expect(res.body).toEqual({ paid: false, reason: "quality_check_failed" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ tier: 1, tierOnHold: true });
  });

  it("counts a passed check toward reopening, and reports it", async () => {
    const userId = await labeler({ tier: 1, xp: 400, tierOnHold: true, holdChecksPassed: 1 });
    const task = await createGoldTask("A");
    const res = await submit(userId, task.id, "A");
    expect(res.body.progress.tier).toEqual({ tier: 1, onHold: true, tierUp: null, holdChecksPassed: 2 });
  });
});

describe("POST /api/submit - tier-up (#202)", () => {
  it("reports the tier the answer opened, once", async () => {
    const userId = await labeler({ xp: 240 });
    const first = await createTask({ difficulty: 2 });
    const second = await createTask({ difficulty: 2 });

    const opened = await submit(userId, first.id, "A");
    expect(opened.body.progress.tier).toEqual({ tier: 1, onHold: false, tierUp: 1, holdChecksPassed: 0 });
    expect(opened.body.progress.stampsAwarded).toEqual(["first-answer"]);

    const next = await submit(userId, second.id, "B");
    expect(next.body.progress.tier.tierUp).toBeNull();
  });
});

describe("POST /api/submit - tier gating (#202)", () => {
  beforeEach(() => {
    vi.stubEnv("GAMIFICATION_GATING", "on");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function nothingWritten(userId: string) {
    expect(await prisma.submission.count({ where: { userId } })).toBe(0);
    expect(await prisma.xpEvent.count({ where: { userId } })).toBe(0);
  }

  it("refuses a task above the labeler's band, before any write", async () => {
    const userId = await labeler();
    const task = await createTask({ difficulty: 9 });
    expect(await submit(userId, task.id, "A")).toEqual({ status: 409, body: { error: "tier_locked" } });
    await nothingWritten(userId);
  });

  it("accepts the top of the band, and a task with no difficulty", async () => {
    const userId = await labeler();
    const top = await createTask({ difficulty: 3 });
    const open = await createTask({ difficulty: null });
    expect((await submit(userId, top.id, "A")).body.status).toBe("pending");
    expect((await submit(userId, open.id, "B")).body.status).toBe("pending");
  });

  it("holds a tier to the band below", async () => {
    const userId = await labeler({ tier: 1, xp: 400, tierOnHold: true });
    const skilled = await createTask({ difficulty: 5 });
    const starter = await createTask({ difficulty: 3 });
    expect((await submit(userId, skilled.id, "A")).body).toEqual({ error: "tier_locked" });
    expect((await submit(userId, starter.id, "A")).body.status).toBe("pending");
  });

  it("refuses a campaign above the labeler's tier, its checks included", async () => {
    const campaign = await createCampaign();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { minTier: 1 } });
    const userId = await labeler();
    const task = await createTask({ difficulty: 1, campaignId: campaign.id });
    const check = await createGoldTask({ goldAnswer: "A", campaignId: campaign.id, prompt: "A campaign check" });
    expect((await submit(userId, task.id, "A")).body).toEqual({ error: "tier_locked" });
    expect((await submit(userId, check.id, "A")).body).toEqual({ error: "tier_locked" });
    await nothingWritten(userId);
  });

  it("accepts a campaign open to the labeler's tier", async () => {
    vi.stubEnv("PLATFORM_FEE_UNITS", "0");
    const campaign = await createCampaign({ rewardUnits: 500_000n });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { minTier: 1 } });
    await createCampaignBalance(campaign.id, 10_000_000n);
    const userId = await labeler({ tier: 1, xp: 400 });
    const task = await createTask({ difficulty: 4, campaignId: campaign.id });
    expect((await submit(userId, task.id, "A")).body.status).toBe("pending");
  });

  it("leaves the global check pool open to every tier", async () => {
    const userId = await labeler();
    const check = await createGoldTask("A");
    expect((await submit(userId, check.id, "A")).body).toMatchObject({ paid: false, reason: "quality_check_passed" });
  });

  it("refuses nothing with GAMIFICATION_GATING off", async () => {
    vi.stubEnv("GAMIFICATION_GATING", "");
    const userId = await labeler();
    const task = await createTask({ difficulty: 9 });
    expect((await submit(userId, task.id, "A")).body.status).toBe("pending");
  });
});
