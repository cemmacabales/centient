// #201 (ADR-0010, §3.1 B) — XP is written after the accepted answer commits, so
// a failed write leaves an accepted answer with no ANSWER event. The repair
// re-derives exactly those, once, and touches nothing else.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createTask, createUser } from "@/tests/helpers/factories";
import { recordAccepted } from "../ledger";
import { repairMissingAnswerXp } from "../repair";

const SINCE = new Date("2026-10-12T00:00:00Z");

beforeEach(async () => {
  await truncateAll();
});

async function accepted(userId: string, difficulty: number | null, overrides: Record<string, unknown> = {}) {
  const task = await createTask({ difficulty });
  return prisma.submission.create({
    data: {
      walletAddress: "G-test",
      userId,
      taskId: task.id,
      choice: "A",
      reason: "r",
      payoutAmountUnits: 1n,
      payoutStatus: "pending",
      createdAt: new Date("2026-10-13T02:00:00Z"),
      ...overrides,
    },
  });
}

describe("repairMissingAnswerXp", () => {
  it("finds accepted answers with no ANSWER event, and writes nothing on a dry run", async () => {
    const user = await createUser();
    const missing = await accepted(user.id, 8);
    const recorded = await accepted(user.id, 2);
    await recordAccepted({ userId: user.id, submissionId: recorded.id, difficulty: 2, isQualityCheck: false });

    const report = await repairMissingAnswerXp({ since: SINCE, apply: false });
    expect(report).toEqual({ missing: [{ submissionId: missing.id, userId: user.id, amount: 20 }], applied: 0 });
    expect(await prisma.xpEvent.count()).toBe(1);
  });

  it("writes each missing event once, dated to the answer, and credits the XP", async () => {
    const user = await createUser();
    const missing = await accepted(user.id, 5);

    expect((await repairMissingAnswerXp({ since: SINCE, apply: true })).applied).toBe(1);
    expect((await repairMissingAnswerXp({ since: SINCE, apply: true })).applied).toBe(0);

    const events = await prisma.xpEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "ANSWER",
      amount: 15,
      submissionId: missing.id,
      dedupeKey: `answer:${missing.id}`,
      dayKey: "2026-10-13",
      weekKey: "2026-10-12",
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.xp).toBe(15);
    // XP only: the day's goal and the streak are left as they stood.
    expect(after.streakDays).toBe(0);
    expect(await prisma.dailyProgress.count()).toBe(0);
  });

  it("ignores rejected answers, quality checks and anything before --since", async () => {
    const user = await createUser();
    await accepted(user.id, 5, { payoutStatus: "skipped", payoutAmountUnits: 0n });
    await accepted(user.id, null, { isGoldCheck: true, goldPassed: true, payoutStatus: "skipped", payoutAmountUnits: 0n });
    await accepted(user.id, 5, { createdAt: new Date("2026-10-11T02:00:00Z") });

    expect(await repairMissingAnswerXp({ since: SINCE, apply: true })).toEqual({ missing: [], applied: 0 });
  });
});
