// #201 — the XP writer against a real database: idempotent awards, the daily
// goal crossed exactly once, and protected days that can't break a streak.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";
import { markProtected, readProgress, recordAccepted } from "../ledger";

// Monday 12 Oct 2026, 10:00 Manila.
const MON = new Date("2026-10-12T02:00:00Z");
const at = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);

let userId: string;

beforeEach(async () => {
  await truncateAll();
  userId = (await createUser()).id;
  // Joined well before the week under test, so its past days can read as missed.
  await prisma.user.update({ where: { id: userId }, data: { createdAt: new Date("2026-10-01T02:00:00Z") } });
});

let seq = 0;
function answer(when: Date, overrides: Partial<Parameters<typeof recordAccepted>[0]> = {}) {
  return recordAccepted({
    userId,
    submissionId: `sub-${++seq}`,
    difficulty: 5,
    isQualityCheck: false,
    at: when,
    ...overrides,
  });
}

async function meetGoal(when: Date) {
  let last;
  for (let i = 0; i < 5; i++) last = await answer(when);
  return last!;
}

describe("recordAccepted", () => {
  it("awards an answer once, however often it is recorded", async () => {
    const first = await answer(MON, { submissionId: "sub-dup", difficulty: 8 });
    const again = await answer(MON, { submissionId: "sub-dup", difficulty: 8 });

    expect(first.lines).toEqual([{ kind: "ANSWER", amount: 20 }]);
    expect(first.xpGained).toBe(20);
    expect(again.lines).toEqual([]);
    expect(again.xpGained).toBe(0);
    expect(again.xpTotal).toBe(20);
    expect(again.today.counted).toBe(1);

    expect(await prisma.xpEvent.count({ where: { userId } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.xp).toBe(20);
  });

  it("throws, rather than reading as already recorded, when another key collides", async () => {
    for (let i = 0; i < 4; i++) await answer(MON);
    // The day's goal row exists already, so the fifth answer's goal award collides.
    await prisma.xpEvent.create({
      data: { userId, kind: "DAILY_GOAL", amount: 20, dedupeKey: `goal:${userId}:2026-10-12`, dayKey: "2026-10-12", weekKey: "2026-10-12" },
    });
    await expect(answer(MON, { submissionId: "sub-fifth" })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.xpEvent.count({ where: { dedupeKey: "answer:sub-fifth" } })).toBe(0);
  });

  it("awards a passed quality check +5 and counts it toward the goal", async () => {
    const r = await answer(MON, { isQualityCheck: true, difficulty: null });
    expect(r.lines).toEqual([{ kind: "QUALITY_CHECK", amount: 5 }]);
    expect(r.today).toEqual({ counted: 1, goal: 5, goalMet: false, goalJustMet: false });
    const event = await prisma.xpEvent.findFirstOrThrow({ where: { userId } });
    expect(event.dedupeKey).toBe(`check:${event.submissionId}`);
    expect(event.dayKey).toBe("2026-10-12");
    expect(event.weekKey).toBe("2026-10-12");
  });

  it("crosses the daily goal exactly once", async () => {
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await answer(MON));

    const crossed = results.filter((r) => r.today.goalJustMet);
    expect(crossed).toHaveLength(1);
    expect(results[4].today).toEqual({ counted: 5, goal: 5, goalMet: true, goalJustMet: true });
    expect(results[4].lines).toEqual([
      { kind: "ANSWER", amount: 15 },
      { kind: "DAILY_GOAL", amount: 20 },
    ]);
    expect(results[4].streak).toMatchObject({ days: 1, best: 1, restDays: 0, restEarned: false });
    expect(results[6].today).toMatchObject({ counted: 7, goalMet: true, goalJustMet: false });

    expect(await prisma.xpEvent.count({ where: { userId, kind: "DAILY_GOAL" } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user).toMatchObject({ xp: 7 * 15 + 20, streakDays: 1, lastGoalDay: "2026-10-12" });
  });

  it("counts days in Manila time, across UTC midnight", async () => {
    // 23:30 Manila Monday, then 00:30 Manila Tuesday: one hour apart, two days.
    await answer(new Date("2026-10-12T15:30:00Z"));
    const tue = await answer(new Date("2026-10-12T16:30:00Z"));
    expect(tue.today.counted).toBe(1);
  });

  it("extends the streak day over day and pays the 3-day milestone", async () => {
    await meetGoal(MON);
    await meetGoal(at(MON, 1));
    const wed = await meetGoal(at(MON, 2));

    expect(wed.streak).toMatchObject({ days: 3, best: 3 });
    expect(wed.lines).toContainEqual({ kind: "STREAK_MILESTONE", amount: 25 });
    const milestone = await prisma.xpEvent.findFirstOrThrow({ where: { userId, kind: "STREAK_MILESTONE" } });
    expect(milestone.dedupeKey).toBe(`streak:${userId}:2026-10-14`);
  });

  it("reports the effective streak before today's goal is met", async () => {
    await meetGoal(MON);
    const tue = await answer(at(MON, 1));
    expect(tue.streak).toMatchObject({ days: 1, best: 1 });
  });

  it("spends a held rest day on a missed day and marks it", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { streakDays: 10, bestStreak: 10, restDays: 1, lastGoalDay: "2026-10-10" },
    });
    // Sunday 11 Oct missed; Monday's goal settles it.
    const r = await meetGoal(MON);
    expect(r.streak).toMatchObject({ days: 11, restDays: 0, restUsed: 1, endedAtDays: null });
    const sunday = await prisma.dailyProgress.findUniqueOrThrow({
      where: { userId_dayKey: { userId, dayKey: "2026-10-11" } },
    });
    expect(sunday.restUsed).toBe(true);
  });

  it("ends a streak whose gap can't be covered, and starts a new one", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { streakDays: 11, bestStreak: 11, restDays: 0, lastGoalDay: "2026-10-09" },
    });
    const r = await meetGoal(MON);
    expect(r.streak).toMatchObject({ days: 1, best: 11, endedAtDays: 11 });
  });
});

describe("markProtected", () => {
  it("keeps a day with nothing open from breaking the streak", async () => {
    await meetGoal(MON);
    await markProtected(userId, at(MON, 1));
    await markProtected(userId, at(MON, 1));

    const wed = await meetGoal(at(MON, 2));
    expect(wed.streak).toMatchObject({ days: 2, restUsed: 0, endedAtDays: null });

    const tue = await prisma.dailyProgress.findUniqueOrThrow({
      where: { userId_dayKey: { userId, dayKey: "2026-10-13" } },
    });
    expect(tue).toMatchObject({ protected: true, counted: 0, restUsed: false });
  });
});

async function readProgressOf(id: string, when: Date) {
  const p = await readProgress(id, when);
  if (!p) throw new Error("no such user");
  return p;
}

describe("readProgress", () => {
  it("is null for an account that no longer exists", async () => {
    expect(await readProgress("00000000-0000-0000-0000-000000000000", MON)).toBeNull();
  });

  it("lays out the Manila week, Monday to Sunday", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { streakDays: 4, bestStreak: 4, restDays: 1, lastGoalDay: "2026-10-11" },
    });
    // Monday met, Tuesday protected, Wednesday missed (rest day covers it).
    await meetGoal(MON);
    await markProtected(userId, at(MON, 1));
    // Thursday, 2 answers so far.
    await answer(at(MON, 3));
    await answer(at(MON, 3));

    const p = await readProgressOf(userId, at(MON, 3));
    expect(p.today).toEqual({ dayKey: "2026-10-15", counted: 2, goal: 5, goalMet: false });
    expect(p.week.map((d) => d.status)).toEqual(["met", "protected", "rest", "today", "open", "open", "open"]);
    expect(p.week[0].dayKey).toBe("2026-10-12");
    expect(p.streak).toEqual({ days: 5, best: 5, restDays: 0, endedAtDays: null });
    expect(p.xpTotal).toBe(7 * 15 + 20);
    expect(p.xpThisWeek).toBe(7 * 15 + 20);
  });

  it("marks uncovered past days as missed and the streak as ended", async () => {
    await meetGoal(MON);
    const p = await readProgressOf(userId, at(MON, 3));
    expect(p.week.map((d) => d.status)).toEqual(["met", "missed", "missed", "today", "open", "open", "open"]);
    expect(p.streak).toEqual({ days: 0, best: 1, restDays: 0, endedAtDays: 1 });
  });

  it("reads days before the account existed as open, not missed", async () => {
    await prisma.user.update({ where: { id: userId }, data: { createdAt: at(MON, 2) } });
    const p = await readProgressOf(userId, at(MON, 3));
    expect(p.week.map((d) => d.status)).toEqual(["open", "open", "missed", "today", "open", "open", "open"]);
  });

  it("excludes last week's XP from this week", async () => {
    await answer(at(MON, -1));
    await answer(MON);
    const p = await readProgressOf(userId, MON);
    expect(p.xpTotal).toBe(30);
    expect(p.xpThisWeek).toBe(15);
  });

  it("reads an empty week for a brand-new labeler", async () => {
    const p = await readProgressOf(userId, MON);
    expect(p).toEqual({
      xpTotal: 0,
      xpThisWeek: 0,
      today: { dayKey: "2026-10-12", counted: 0, goal: 5, goalMet: false },
      week: [
        { dayKey: "2026-10-12", status: "today" },
        { dayKey: "2026-10-13", status: "open" },
        { dayKey: "2026-10-14", status: "open" },
        { dayKey: "2026-10-15", status: "open" },
        { dayKey: "2026-10-16", status: "open" },
        { dayKey: "2026-10-17", status: "open" },
        { dayKey: "2026-10-18", status: "open" },
      ],
      streak: { days: 0, best: 0, restDays: 0, endedAtDays: null },
    });
  });
});
