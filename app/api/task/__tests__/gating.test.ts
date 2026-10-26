// #202 — tier gating in task assignment: each tier's difficulty band, tasks
// with no difficulty open to all, Campaign.minTier, holds, and the server flag
// that keeps serving unchanged until it is on.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { standInDifficulty, tierOfDifficulty } from "@/lib/gamification/tiers";
import { answerXp } from "@/lib/gamification/rules";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/task/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createGoldTask, createTask, createUser } from "@/tests/helpers/factories";

const old = new Date("2026-01-01T00:00:00Z");
const newer = new Date("2026-01-02T00:00:00Z");

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
  // Off the gold path, so the regular query decides.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubEnv("GAMIFICATION_GATING", "on");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function labeler(tier: number, onHold = false) {
  const user = await createUser();
  await prisma.user.update({ where: { id: user.id }, data: { tier, tierOnHold: onHold } });
  return user.id;
}

async function served(userId: string) {
  const res = await GET(
    new NextRequest("http://localhost/api/task", {
      headers: { cookie: `labeler_session=${await signLabelerJWT(userId)}` },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).task as { id: string; tier: number; xp: number | null } | null;
}

/** An out-of-band task first, so the oldest-first order would serve it if it weren't filtered. */
async function blockedThenOpen(blocked: number, open: number) {
  const b = await createTask({ difficulty: blocked, createdAt: old });
  const o = await createTask({ difficulty: open, createdAt: newer });
  return { blocked: b.id, open: o.id };
}

describe("GET /api/task - tier bands (#202)", () => {
  it.each([
    [0, 4, 3],
    [1, 6, 5],
    [2, 8, 7],
  ])("tier %i skips difficulty %i and serves %i", async (tier, blocked, open) => {
    const ids = await blockedThenOpen(blocked, open);
    expect((await served(await labeler(tier)))?.id).toBe(ids.open);
  });

  it("serves Expert up to difficulty 9", async () => {
    const t = await createTask({ difficulty: 9 });
    expect((await served(await labeler(3)))?.id).toBe(t.id);
  });

  it("serves a task with no difficulty to every tier", async () => {
    const t = await createTask({ difficulty: null });
    expect((await served(await labeler(0)))?.id).toBe(t.id);
  });

  it("serves nothing, and protects today, when every open task is above the band", async () => {
    await createTask({ difficulty: 6 });
    const userId = await labeler(0);
    expect(await served(userId)).toBeNull();
    expect(await prisma.dailyProgress.findFirst({ where: { userId } })).toMatchObject({ protected: true });
  });
});

describe("GET /api/task - holds (#202)", () => {
  it("drops a held tier to the band below", async () => {
    const ids = await blockedThenOpen(4, 3);
    expect((await served(await labeler(1, true)))?.id).toBe(ids.open);
  });

  it("drops held Trusted to Skilled's band", async () => {
    const ids = await blockedThenOpen(6, 5);
    expect((await served(await labeler(2, true)))?.id).toBe(ids.open);
  });
});

describe("GET /api/task - Campaign.minTier (#202)", () => {
  it("keeps a Skilled-and-up campaign from Starter", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { minTier: 1 } });
    await createTask({ campaignId: campaign.id, difficulty: 1, createdAt: old });
    const open = await createTask({ difficulty: 1, createdAt: newer });
    expect((await served(await labeler(0)))?.id).toBe(open.id);
  });

  it("serves it to Skilled", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { minTier: 1 } });
    const t = await createTask({ campaignId: campaign.id, difficulty: 1 });
    expect((await served(await labeler(1)))?.id).toBe(t.id);
  });

  it("keeps it from Skilled on hold", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { minTier: 1 } });
    await createTask({ campaignId: campaign.id, difficulty: 1 });
    expect(await served(await labeler(1, true))).toBeNull();
  });

  it("serves an Everyone campaign to Starter", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    const t = await createTask({ campaignId: campaign.id, difficulty: 2 });
    expect((await served(await labeler(0)))?.id).toBe(t.id);
  });
});

describe("GET /api/task - the task's tier, for the chip (#202)", () => {
  it.each([
    [null, 0],
    [3, 0],
    [4, 1],
    [5, 1],
    [7, 2],
    [9, 3],
  ])("difficulty %s is a tier-%i task", async (difficulty, tier) => {
    await createTask({ difficulty });
    expect((await served(await labeler(3)))?.tier).toBe(tier);
  });

  it("shows a quality check as a task from the labeler's own band, the same each time", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const gold = await createGoldTask("A");
    const expert = await labeler(3);
    const first = await served(expert);
    expect(first?.id).toBe(gold.id);
    const shown = standInDifficulty(`${gold.id}:${expert}`, 9);
    expect(first?.tier).toBe(tierOfDifficulty(shown));
    expect(first?.xp).toBe(answerXp(shown));
    expect(await served(expert)).toMatchObject({ tier: first?.tier, xp: first?.xp });

    // A Starter is served up to difficulty 3, so a check never reads above it.
    expect((await served(await labeler(0)))?.tier).toBe(0);
  });

  it("borrows a real task's difficulty for a check when the band has one", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await createGoldTask("A");
    await createTask({ difficulty: 4 });
    expect(await served(await labeler(3))).toMatchObject({ tier: 1, xp: 15 });
  });
});

describe("GET /api/task - GAMIFICATION_GATING off (#202)", () => {
  it("serves every difficulty and every campaign to Starter, as before", async () => {
    vi.stubEnv("GAMIFICATION_GATING", "");
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { minTier: 2 } });
    const hard = await createTask({ campaignId: campaign.id, difficulty: 9, createdAt: old });
    await createTask({ difficulty: 1, createdAt: newer });
    expect((await served(await labeler(0)))?.id).toBe(hard.id);
  });
});
