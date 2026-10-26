// #203 — weekly quests against a real database: awarded on the answer that
// completes them, once per Manila week, as QUEST XP that counts on the board.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { prisma, truncateAll } from "@/tests/helpers/db";
import { createGoldTask, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";
import { captureServer } from "../server-analytics";
import { recordAccepted } from "../ledger";
import { readQuests } from "../quest-ledger";
import { weekEntries } from "../leaderboard";

// Wednesday 14 Oct 2026, Manila. The week runs 12–18 Oct.
const WED = new Date("2026-10-14T02:00:00Z");
const LAST_WEEK = new Date("2026-10-08T02:00:00Z");

let userId: string;
let tick = 0;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(captureServer).mockReset();
  tick = 0;
  userId = (await createUser()).id;
});

const later = (base: Date) => new Date(base.getTime() + ++tick * 60_000);

async function answer(category: string | null, at = WED) {
  const task = await createTask({ category, difficulty: 2 });
  const when = later(at);
  const sub = await prisma.submission.create({
    data: { userId, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1n, payoutStatus: "pending", createdAt: when },
  });
  return recordAccepted({ userId, submissionId: sub.id, difficulty: 2, isQualityCheck: false, at: when });
}

async function passCheck(at = WED) {
  const task = await createGoldTask("A");
  const when = later(at);
  const sub = await prisma.submission.create({
    data: {
      userId,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      isGoldCheck: true,
      goldPassed: true,
      payoutAmountUnits: 0n,
      payoutStatus: "skipped",
      createdAt: when,
    },
  });
  return recordAccepted({ userId, submissionId: sub.id, difficulty: null, isQualityCheck: true, at: when });
}

const questLines = (p: Awaited<ReturnType<typeof recordAccepted>>) => p.lines.filter((l) => l.kind === "QUEST");

describe("quests on the answer that completes them", () => {
  it("awards Answer 5 health tasks on the fifth, once, as 30 XP on the receipt", async () => {
    for (let i = 0; i < 4; i++) expect(questLines(await answer("health"))).toEqual([]);
    await answer("coding");
    const fifth = await answer("health");
    expect(questLines(fifth)).toEqual([{ kind: "QUEST", amount: 30, quest: "health-5" }]);
    expect(fifth.xpGained).toBe(10 + 30);

    expect(questLines(await answer("health"))).toEqual([]);
    const rows = await prisma.xpEvent.findMany({ where: { userId, kind: "QUEST" } });
    expect(rows).toMatchObject([{ amount: 30, dedupeKey: `quest:health-5:${userId}:2026-10-12`, weekKey: "2026-10-12" }]);
    expect(vi.mocked(captureServer).mock.calls.filter((c) => c[1] === "quest_completed")).toEqual([
      [userId, "quest_completed", { quest: "health-5", xp: 30 }],
    ]);
  });

  it("counts only this Manila week: last week's checks don't carry over", async () => {
    await passCheck(LAST_WEEK);
    await passCheck(LAST_WEEK);
    await passCheck();
    const second = await passCheck();
    expect(questLines(second)).toEqual([]);
    expect(questLines(await passCheck())).toEqual([{ kind: "QUEST", amount: 30, quest: "checks-3" }]);
  });

  it("awards Meet the daily goal on 4 days on the answer that meets the fourth", async () => {
    for (const day of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      await prisma.dailyProgress.create({ data: { userId, dayKey: day, counted: 5, goalMet: true } });
    }
    const thu = new Date("2026-10-15T02:00:00Z");
    let last;
    for (let i = 0; i < 5; i++) last = await answer(null, thu);
    expect(questLines(last!)).toEqual([{ kind: "QUEST", amount: 30, quest: "goal-days-4" }]);
  });

  it("counts quest XP on the board: it's labor", async () => {
    for (let i = 0; i < 5; i++) await answer("health");
    const [entry] = await weekEntries("2026-10-12");
    // Five answers, the daily goal (+20) and the quest (+30).
    expect(entry.xp).toBe(5 * 10 + 20 + 30);
  });

  it("awards each quest once when answers race", async () => {
    for (let i = 0; i < 3; i++) await answer("health");
    await Promise.all([answer("health"), answer("health"), answer("health")]);
    expect(await prisma.xpEvent.count({ where: { userId, kind: "QUEST" } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ledger = await prisma.xpEvent.aggregate({ where: { userId }, _sum: { amount: true } });
    expect(user.xp).toBe(ledger._sum.amount);
  });
});

describe("readQuests", () => {
  it("shows this week's progress and which are done", async () => {
    for (let i = 0; i < 5; i++) await answer("health");
    await passCheck();
    const quests = await readQuests(userId, WED);
    expect(quests.map((q) => [q.id, q.current, q.target, q.done])).toEqual([
      ["health-5", 5, 5, true],
      ["checks-3", 1, 3, false],
      ["goal-days-4", 1, 4, false],
    ]);
  });

  it("starts over the next week", async () => {
    for (let i = 0; i < 5; i++) await answer("health");
    const next = await readQuests(userId, new Date("2026-10-19T02:00:00Z"));
    expect(next.every((q) => q.current === 0 && !q.done)).toBe(true);
  });
});
