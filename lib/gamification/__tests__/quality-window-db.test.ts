// #202 — the signals tiers and stamps read, against a real database: the last
// quality checks (retest kept out), the crowd window (ties kept out), active
// days, and the stamp counts.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createGoldTask, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";
import { readStampStats, readTierSignals } from "../quality-window";

const T0 = new Date("2026-10-12T02:00:00Z").getTime();
let tick = 0;
const nextAt = () => new Date(T0 + ++tick * 60_000);

let userId: string;

beforeEach(async () => {
  await truncateAll();
  tick = 0;
  userId = (await createUser()).id;
});

async function check(passed: boolean, opts: { retest?: boolean; at?: Date } = {}) {
  const task = await createGoldTask("A");
  return prisma.submission.create({
    data: {
      userId,
      taskId: task.id,
      choice: passed ? "A" : "B",
      reason: VALID_REASON,
      isGoldCheck: true,
      goldPassed: passed,
      retest: opts.retest ?? false,
      payoutAmountUnits: 0n,
      payoutStatus: "skipped",
      createdAt: opts.at ?? nextAt(),
    },
  });
}

async function answer(opts: {
  choice?: "A" | "B";
  status?: string;
  category?: string | null;
  resolved?: { majority: "A" | "B"; agreement: number } | null;
}) {
  const task = await createTask({ category: opts.category ?? null });
  if (opts.resolved) {
    await prisma.task.update({
      where: { id: task.id },
      data: { majorityAnswer: opts.resolved.majority, agreementScore: opts.resolved.agreement, resolvedAt: new Date() },
    });
  }
  return prisma.submission.create({
    data: {
      userId,
      taskId: task.id,
      choice: opts.choice ?? "A",
      reason: VALID_REASON,
      payoutAmountUnits: 1n,
      payoutStatus: opts.status ?? "confirmed",
      createdAt: nextAt(),
    },
  });
}

describe("readTierSignals: checks", () => {
  it("reads the last 10 checks, newest first", async () => {
    for (let i = 0; i < 5; i++) await check(false);
    for (let i = 0; i < 10; i++) await check(true);
    const s = await readTierSignals(prisma, userId);
    expect(s.checks).toEqual({ passed: 10, total: 10 });
  });

  it("counts a short history as it stands", async () => {
    await check(true);
    await check(false);
    await check(true);
    expect((await readTierSignals(prisma, userId)).checks).toEqual({ passed: 2, total: 3 });
  });

  it("keeps retest checks out", async () => {
    await check(true);
    await check(false, { retest: true });
    await check(false, { retest: true });
    expect((await readTierSignals(prisma, userId)).checks).toEqual({ passed: 1, total: 1 });
  });

  it("keeps a gold row with no verdict out (a left-bias skip)", async () => {
    const task = await createGoldTask("A");
    await prisma.submission.create({
      data: {
        userId,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        isGoldCheck: true,
        payoutAmountUnits: 0n,
        payoutStatus: "skipped",
      },
    });
    expect((await readTierSignals(prisma, userId)).checks).toEqual({ passed: 0, total: 0 });
  });

  it("reads only this labeler's checks", async () => {
    await check(true);
    const other = (await createUser()).id;
    const task = await createGoldTask("A");
    await prisma.submission.create({
      data: { userId: other, taskId: task.id, choice: "B", reason: VALID_REASON, isGoldCheck: true, goldPassed: false, payoutAmountUnits: 0n, payoutStatus: "skipped" },
    });
    expect((await readTierSignals(prisma, userId)).checks).toEqual({ passed: 1, total: 1 });
  });
});

describe("readTierSignals: crowd", () => {
  it("counts settled answers on resolved tasks that matched the majority", async () => {
    await answer({ choice: "A", resolved: { majority: "A", agreement: 0.8 } });
    await answer({ choice: "B", resolved: { majority: "A", agreement: 0.8 } });
    await answer({ choice: "B", resolved: { majority: "B", agreement: 0.6 } });
    expect((await readTierSignals(prisma, userId)).crowd).toEqual({ matched: 2, total: 3 });
  });

  it("keeps ties out: a 50/50 task has no crowd to match", async () => {
    await answer({ choice: "A", resolved: { majority: "A", agreement: 0.5 } });
    await answer({ choice: "A", resolved: { majority: "A", agreement: 0.75 } });
    expect((await readTierSignals(prisma, userId)).crowd).toEqual({ matched: 1, total: 1 });
  });

  it("keeps unresolved tasks and unsettled answers out", async () => {
    await answer({ choice: "A", resolved: null });
    await answer({ choice: "A", status: "pending", resolved: { majority: "A", agreement: 0.9 } });
    await answer({ choice: "A", status: "failed", resolved: { majority: "A", agreement: 0.9 } });
    expect((await readTierSignals(prisma, userId)).crowd).toEqual({ matched: 0, total: 0 });
  });

  it("reads only the last 50", async () => {
    for (let i = 0; i < 10; i++) await answer({ choice: "B", resolved: { majority: "A", agreement: 0.9 } });
    for (let i = 0; i < 50; i++) await answer({ choice: "A", resolved: { majority: "A", agreement: 0.9 } });
    expect((await readTierSignals(prisma, userId)).crowd).toEqual({ matched: 50, total: 50 });
  });
});

describe("readTierSignals: XP and active days", () => {
  it("reads the labeler's XP and the days with a counted answer", async () => {
    await prisma.user.update({ where: { id: userId }, data: { xp: 320 } });
    await prisma.dailyProgress.createMany({
      data: [
        { userId, dayKey: "2026-10-10", counted: 3 },
        { userId, dayKey: "2026-10-11", counted: 0, protected: true },
        { userId, dayKey: "2026-10-12", counted: 1 },
      ],
    });
    const s = await readTierSignals(prisma, userId);
    expect(s.xp).toBe(320);
    expect(s.activeDays).toBe(2);
  });
});

describe("readStampStats", () => {
  it("counts accepted answers and passed checks, not rejected ones or retest", async () => {
    await answer({ status: "pending" });
    await answer({ status: "confirmed" });
    await answer({ status: "skipped" });
    await check(true);
    await check(false);
    await check(true, { retest: true });
    const s = await readStampStats(prisma, userId);
    expect(s.answers).toBe(3);
  });

  it("counts settled payouts only", async () => {
    await answer({ status: "pending" });
    await answer({ status: "sent" });
    await answer({ status: "confirmed" });
    expect((await readStampStats(prisma, userId)).payouts).toBe(2);
  });

  it("reads the run of passed checks, newest first", async () => {
    await check(true);
    await check(false);
    await check(true);
    await check(true);
    await check(false, { retest: true });
    await check(true);
    expect((await readStampStats(prisma, userId)).checkRun).toBe(3);
  });

  it("counts lifetime crowd matches, ties excluded", async () => {
    for (let i = 0; i < 60; i++) await answer({ choice: "A", resolved: { majority: "A", agreement: 0.9 } });
    await answer({ choice: "A", resolved: { majority: "A", agreement: 0.5 } });
    expect((await readStampStats(prisma, userId)).crowdMatches).toBe(60);
  });

  it("counts distinct categories and health answers among accepted answers", async () => {
    await answer({ category: "health" });
    await answer({ category: "health" });
    await answer({ category: "banking" });
    await answer({ category: "hr", status: "skipped" });
    await answer({ category: null });
    const s = await readStampStats(prisma, userId);
    expect(s.categories).toBe(2);
    expect(s.healthAnswers).toBe(2);
  });

  it("reads the best streak from the labeler", async () => {
    await prisma.user.update({ where: { id: userId }, data: { bestStreak: 9, streakDays: 2 } });
    expect((await readStampStats(prisma, userId)).bestStreak).toBe(9);
  });
});
