// #202 — the standing writer against a real database: tiers persisted and
// reported once, holds and reopening, stamps unique per labeler, and each
// PostHog event sent once, also under concurrency.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../server-analytics", () => ({ captureStanding: vi.fn() }));

import { prisma, truncateAll } from "@/tests/helpers/db";
import { createGoldTask, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";
import { captureStanding } from "../server-analytics";
import { updateStanding } from "../standing";
import { recordAccepted } from "../ledger";

let userId: string;
let tick = 0;
const nextAt = () => new Date(Date.UTC(2026, 9, 12, 2) + ++tick * 60_000);

beforeEach(async () => {
  await truncateAll();
  vi.mocked(captureStanding).mockReset();
  tick = 0;
  userId = (await createUser()).id;
});

async function check(passed: boolean) {
  const task = await createGoldTask("A");
  return prisma.submission.create({
    data: {
      userId,
      taskId: task.id,
      choice: passed ? "A" : "B",
      reason: VALID_REASON,
      isGoldCheck: true,
      goldPassed: passed,
      payoutAmountUnits: 0n,
      payoutStatus: "skipped",
      createdAt: nextAt(),
    },
  });
}

async function accepted(status = "pending") {
  const task = await createTask();
  return prisma.submission.create({
    data: { userId, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1n, payoutStatus: status, createdAt: nextAt() },
  });
}

const events = () => vi.mocked(captureStanding).mock.calls.map((c) => c[1]);

describe("updateStanding: tiers", () => {
  it("opens Skilled at 250 XP, persists it and reports it once", async () => {
    await prisma.user.update({ where: { id: userId }, data: { xp: 250 } });
    const first = await updateStanding(userId, "answer");
    const again = await updateStanding(userId, "answer");

    expect(first).toMatchObject({ tier: 1, onHold: false, tierUp: 1 });
    expect(again).toMatchObject({ tier: 1, tierUp: null });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({ tier: 1, tierOnHold: false });
    expect(events()).toEqual([{ tierUp: 1, heldNow: false, reopened: false, stampsAwarded: [], tier: 1 }]);
  });

  it("holds Skilled when a failed check drops it under the floor, and reopens after 3 passes", async () => {
    await prisma.user.update({ where: { id: userId }, data: { xp: 300, tier: 1 } });
    for (let i = 0; i < 6; i++) await check(true);
    for (let i = 0; i < 4; i++) await check(false);

    const held = await updateStanding(userId, "check_failed");
    expect(held).toMatchObject({ tier: 1, onHold: true, heldNow: true, holdChecksPassed: 0 });

    for (let i = 1; i <= 2; i++) {
      await check(true);
      expect(await updateStanding(userId, "check_passed")).toMatchObject({ onHold: true, holdChecksPassed: i });
    }
    await check(true);
    const reopened = await updateStanding(userId, "check_passed");
    expect(reopened).toMatchObject({ tier: 1, onHold: false, reopened: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({ tier: 1, tierOnHold: false, holdChecksPassed: 0 });
    expect(events().filter((e) => e.heldNow)).toHaveLength(1);
  });

  it("never lowers the stored tier", async () => {
    await prisma.user.update({ where: { id: userId }, data: { xp: 0, tier: 2 } });
    expect((await updateStanding(userId, "answer")).tier).toBe(2);
  });
});

describe("updateStanding: stamps", () => {
  it("awards a reached stamp once and records it", async () => {
    await accepted();
    const first = await updateStanding(userId, "answer");
    const again = await updateStanding(userId, "answer");

    expect(first.stampsAwarded).toEqual(["first-answer"]);
    expect(again.stampsAwarded).toEqual([]);
    expect(await prisma.userStamp.findMany({ where: { userId }, select: { stampId: true } })).toEqual([
      { stampId: "first-answer" },
    ]);
  });

  it("awards First payout once the payout settles", async () => {
    await accepted("sent");
    expect((await updateStanding(userId, "payout")).stampsAwarded).toEqual(["first-answer", "first-payout"]);
  });

  it("awards and reports once under concurrent writers", async () => {
    await accepted("sent");
    await prisma.user.update({ where: { id: userId }, data: { xp: 250 } });
    const results = await Promise.all(Array.from({ length: 5 }, () => updateStanding(userId, "answer")));

    expect(results.flatMap((r) => r.stampsAwarded).sort()).toEqual(["first-answer", "first-payout"]);
    expect(results.filter((r) => r.tierUp === 1)).toHaveLength(1);
    expect(await prisma.userStamp.count({ where: { userId } })).toBe(2);
    expect(events().filter((e) => e.tierUp === 1)).toHaveLength(1);
  });
});

describe("recordAccepted: the progress block (#202)", () => {
  it("carries the tier, the tier-up and the stamps the answer earned", async () => {
    await prisma.user.update({ where: { id: userId }, data: { xp: 240 } });
    const sub = await accepted();
    const r = await recordAccepted({ userId, submissionId: sub.id, difficulty: 2, isQualityCheck: false });

    expect(r.xpTotal).toBe(250);
    expect(r.tier).toEqual({ tier: 1, onHold: false, tierUp: 1, holdChecksPassed: 0 });
    expect(r.stampsAwarded).toEqual(["first-answer"]);
  });

  it("reports nothing new when the same answer is recorded again", async () => {
    await prisma.user.update({ where: { id: userId }, data: { xp: 240 } });
    const sub = await accepted();
    await recordAccepted({ userId, submissionId: sub.id, difficulty: 2, isQualityCheck: false });
    const again = await recordAccepted({ userId, submissionId: sub.id, difficulty: 2, isQualityCheck: false });

    expect(again.tier).toEqual({ tier: 1, onHold: false, tierUp: null, holdChecksPassed: 0 });
    expect(again.stampsAwarded).toEqual([]);
  });

  it("still returns the XP when the standing write fails", async () => {
    const sub = await accepted();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_user_stamps() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced user_stamps insert failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_refuse_user_stamps BEFORE INSERT ON "user_stamps"
      FOR EACH ROW EXECUTE FUNCTION test_refuse_user_stamps()`);
    try {
      const r = await recordAccepted({ userId, submissionId: sub.id, difficulty: 2, isQualityCheck: false });
      expect(r.xpGained).toBe(10);
      expect(r.tier).toEqual({ tier: 0, onHold: false, tierUp: null, holdChecksPassed: 0 });
      expect(r.stampsAwarded).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_user_stamps ON "user_stamps"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_user_stamps()`);
    }
  });
});
