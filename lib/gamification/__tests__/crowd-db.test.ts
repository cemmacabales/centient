// #202 — resolution and crowd-match XP beside the payout rail: the
// resolution-only threshold, +5 per answer matching the majority, nothing for a
// tie, idempotent, and a failing XP write or target-less resolution that still
// lets the job reach `done`.
// Lives outside the payments lane: the lane's own suites run unchanged.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return { ...actual, payReward: vi.fn() };
});
vi.mock("@/lib/campaign-balance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/campaign-balance")>();
  return { ...actual, creditBalance: vi.fn() };
});
vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));
vi.mock("../server-analytics", () => ({ captureStanding: vi.fn() }));

import { processJob } from "@/lib/payout-worker";
import { payReward } from "@/lib/payout";
import { RESOLUTION_MIN_ANSWERS } from "@/lib/constants";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

const AMOUNT = 1_000_000n;
let hash = 0;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(payReward).mockReset();
  vi.mocked(payReward).mockImplementation(async () => `tx-${++hash}`);
});

/** A settled answer by a new labeler. */
async function settled(taskId: string, choice: "A" | "B") {
  const user = await createUser();
  return prisma.submission.create({
    data: { userId: user.id, walletAddress: user.walletAddress, taskId, choice, reason: VALID_REASON, payoutAmountUnits: AMOUNT, payoutStatus: "confirmed" },
  });
}

/** A pending answer with its job, then the worker pays it. */
async function payNew(taskId: string, choice: "A" | "B") {
  const user = await createUser();
  const sub = await prisma.submission.create({
    data: { userId: user.id, walletAddress: user.walletAddress, taskId, choice, reason: VALID_REASON, payoutAmountUnits: AMOUNT, payoutStatus: "pending" },
  });
  const job = await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: sub.id, status: "processing" } });
  await processJob(job.id, sub.id, user.id, AMOUNT, "SUBMISSION_PAYOUT");
  return { sub, job, userId: user.id };
}

const crowdXp = (submissionId: string) => prisma.xpEvent.findMany({ where: { kind: "CROWD_MATCH", submissionId } });

describe("resolution without a response target (§3.1 A)", () => {
  it(`resolves a target-less task at ${RESOLUTION_MIN_ANSWERS} settled answers`, async () => {
    expect(RESOLUTION_MIN_ANSWERS).toBe(5);
    const task = await createTask({ responseTarget: null });
    for (const c of ["A", "A", "B", "A"] as const) await settled(task.id, c);
    await payNew(task.id, "A");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.resolvedAt).not.toBeNull();
    expect(after.majorityAnswer).toBe("A");
    expect(after.agreementScore).toBeCloseTo(0.8);
  });

  it("leaves it open one answer short", async () => {
    const task = await createTask({ responseTarget: null });
    for (const c of ["A", "B", "A"] as const) await settled(task.id, c);
    await payNew(task.id, "A");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).resolvedAt).toBeNull();
  });

  it("uses the campaign's default target for a campaign task with none of its own", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 3 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });
    for (const c of ["A", "B"] as const) await settled(task.id, c);
    await payNew(task.id, "B");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).majorityAnswer).toBe("B");
  });

  it("never overwrites a task another worker already resolved", async () => {
    const task = await createTask({ responseTarget: 2 });
    await settled(task.id, "A");
    // Resolved as B by a concurrent settlement after this job read the task.
    const job = await payNewAfter(task.id, "A", async () => {
      await prisma.task.update({ where: { id: task.id }, data: { majorityAnswer: "B", agreementScore: 1, resolvedAt: new Date() } });
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).majorityAnswer).toBe("B");
    expect((await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
  });

  it("never quarantines a paid answer when resolving a target-less task fails; the next payout resolves it", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_task_updates() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced tasks update failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_refuse_task_updates BEFORE UPDATE ON "tasks"
      FOR EACH ROW EXECUTE FUNCTION test_refuse_task_updates()`);
    const task = await createTask({ responseTarget: null });
    for (const c of ["A", "A", "B", "A"] as const) await settled(task.id, c);
    let paid: Awaited<ReturnType<typeof payNew>>;
    try {
      paid = await payNew(task.id, "A");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_task_updates ON "tasks"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_task_updates()`);
    }

    const job = await prisma.payoutJob.findUniqueOrThrow({ where: { id: paid.job.id } });
    expect(job.status).toBe("done");
    expect(job.lastError).toBeNull();
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: paid.sub.id } })).payoutStatus).toBe("sent");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).resolvedAt).toBeNull();

    await payNew(task.id, "A");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).majorityAnswer).toBe("A");
  });
});

/** Pay a new answer, running `between` after the worker has read the task. */
async function payNewAfter(taskId: string, choice: "A" | "B", between: () => Promise<void>) {
  vi.mocked(payReward).mockImplementationOnce(async () => {
    await between();
    return `tx-${++hash}`;
  });
  return (await payNew(taskId, choice)).job;
}

describe("crowd-match XP", () => {
  it("awards +5 to each settled answer that matched the majority, once", async () => {
    const task = await createTask({ responseTarget: 3 });
    const a1 = await settled(task.id, "A");
    const b1 = await settled(task.id, "B");
    const { sub: a2, userId } = await payNew(task.id, "A");

    for (const s of [a1, a2]) {
      const events = await crowdXp(s.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ amount: 5, dedupeKey: `crowd:${s.id}` });
    }
    expect(await crowdXp(b1.id)).toHaveLength(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).xp).toBe(5);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b1.userId } })).xp).toBe(0);
  });

  it("awards nothing on a tie: the recorded A is only the tie-break", async () => {
    const task = await createTask({ responseTarget: 4 });
    for (const c of ["A", "B", "B"] as const) await settled(task.id, c);
    await payNew(task.id, "A");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.agreementScore).toBe(0.5);
    expect(await prisma.xpEvent.count({ where: { kind: "CROWD_MATCH" } })).toBe(0);
  });

  it("awards only the late answer when one settles on a task already resolved", async () => {
    const task = await createTask({ responseTarget: 2 });
    await settled(task.id, "A");
    await payNew(task.id, "A");
    expect(await prisma.xpEvent.count({ where: { kind: "CROWD_MATCH" } })).toBe(2);

    const late = await payNew(task.id, "A");
    expect(await crowdXp(late.sub.id)).toHaveLength(1);
    expect(await prisma.xpEvent.count({ where: { kind: "CROWD_MATCH" } })).toBe(3);
  });

  it("awards nothing to a late answer that missed the majority", async () => {
    const task = await createTask({ responseTarget: 2 });
    await settled(task.id, "A");
    await payNew(task.id, "A");
    const late = await payNew(task.id, "B");
    expect(await crowdXp(late.sub.id)).toHaveLength(0);
  });

  it("still marks the job done, and the task resolved, when the XP write fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_xp_events() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced xp_events insert failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_refuse_xp_events BEFORE INSERT ON "xp_events"
      FOR EACH ROW EXECUTE FUNCTION test_refuse_xp_events()`);
    try {
      const task = await createTask({ responseTarget: 2 });
      await settled(task.id, "A");
      const { sub, job } = await payNew(task.id, "A");

      expect((await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("done");
      expect((await prisma.submission.findUniqueOrThrow({ where: { id: sub.id } })).payoutStatus).toBe("sent");
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).resolvedAt).not.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_xp_events ON "xp_events"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_xp_events()`);
    }
  });
});

describe("standing after a payout", () => {
  it("awards First payout once the worker settles the answer", async () => {
    const task = await createTask();
    const { userId } = await payNew(task.id, "A");
    const stamps = await prisma.userStamp.findMany({ where: { userId }, select: { stampId: true } });
    expect(stamps.map((s) => s.stampId).sort()).toEqual(["first-answer", "first-payout"]);
  });

  it("puts Trusted on hold when a crowd miss drops it under 70%", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { tier: 2, xp: 2000 } });
    // 20 resolved answers at exactly 70%: this miss tips it under.
    for (let i = 0; i < 20; i++) {
      const t = await createTask();
      await prisma.task.update({ where: { id: t.id }, data: { majorityAnswer: "A", agreementScore: 0.9, resolvedAt: new Date() } });
      await prisma.submission.create({
        data: { userId: user.id, taskId: t.id, choice: i < 14 ? "A" : "B", reason: VALID_REASON, payoutAmountUnits: AMOUNT, payoutStatus: "confirmed", createdAt: new Date(Date.UTC(2026, 9, 1) + i * 1000) },
      });
    }
    const task = await createTask({ responseTarget: 3 });
    await settled(task.id, "A");
    await settled(task.id, "A");
    const sub = await prisma.submission.create({
      data: { userId: user.id, walletAddress: user.walletAddress, taskId: task.id, choice: "B", reason: VALID_REASON, payoutAmountUnits: AMOUNT, payoutStatus: "pending" },
    });
    const job = await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: sub.id, status: "processing" } });
    await processJob(job.id, sub.id, user.id, AMOUNT, "SUBMISSION_PAYOUT");

    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ tier: 2, tierOnHold: true });
  });
});
