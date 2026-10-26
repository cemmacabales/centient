// The XP writer (#201, ADR-0010). It runs beside the payout rail, never inside
// it: the submit route calls recordAccepted only after the answer's own
// transaction has committed, so nothing here can roll back an accepted answer
// or its payout job. Every award carries a unique dedupeKey, so recording the
// same answer twice awards it once.

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import type { Prisma, XpKind } from "@/app/generated/prisma/client";
import {
  answerXp,
  DAILY_GOAL_XP,
  effectiveStreak,
  QUALITY_CHECK_XP,
  settleStreak,
  type StreakState,
} from "./rules";
import { awardQuests } from "./quest-ledger";
import { updateStanding } from "./standing";
import { manilaDayKey, manilaWeekKey, weekDayKeys, weekKeyOf } from "./time";
import {
  DAILY_GOAL,
  type Progress,
  type ProgressLine,
  type ProgressSummary,
  type TierStatus,
  type WeekDayStatus,
} from "./types";

export type { Progress, ProgressLine, ProgressSummary, WeekDayStatus };

type Tx = Prisma.TransactionClient;
type Db = Pick<Tx, "dailyProgress">;

export interface AcceptedAnswer {
  userId: string;
  submissionId: string;
  difficulty: number | null;
  isQualityCheck: boolean;
  at?: Date;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/** The answer's own XP row already exists: it was recorded before. */
class AlreadyRecorded extends Error {}

const streakSelect = { xp: true, streakDays: true, bestStreak: true, restDays: true, lastGoalDay: true } as const;
const tierSelect = { tier: true, tierOnHold: true, holdChecksPassed: true } as const;

function tierAsStored(user: { tier: number; tierOnHold: boolean; holdChecksPassed: number }): TierStatus {
  return { tier: user.tier, onHold: user.tierOnHold, tierUp: null, holdChecksPassed: user.holdChecksPassed };
}

/**
 * #202: the tier and stamps after this answer. Best effort, after the XP has
 * committed: a failure leaves the tier as stored and the XP stands.
 */
async function withStanding(
  progress: Omit<Progress, "tier" | "stampsAwarded">,
  stored: TierStatus,
  { userId, submissionId, isQualityCheck }: AcceptedAnswer,
): Promise<Progress> {
  try {
    const s = await updateStanding(userId, isQualityCheck ? "check_passed" : "answer");
    return {
      ...progress,
      tier: { tier: s.tier, onHold: s.onHold, tierUp: s.tierUp, holdChecksPassed: s.holdChecksPassed },
      stampsAwarded: s.stampsAwarded,
    };
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "xp-standing", userId, submissionId } });
    return { ...progress, tier: stored, stampsAwarded: [] };
  }
}

/**
 * #203: quests this answer completed, after its XP has committed and before
 * its tier is weighed, so their XP can open one. Best effort, like standing.
 */
async function withQuests(
  progress: Omit<Progress, "tier" | "stampsAwarded">,
  { userId, submissionId, at = new Date() }: AcceptedAnswer,
): Promise<Omit<Progress, "tier" | "stampsAwarded">> {
  try {
    const lines = await awardQuests(userId, at);
    if (lines.length === 0) return progress;
    const gained = lines.reduce((sum, l) => sum + l.amount, 0);
    return { ...progress, lines: [...progress.lines, ...lines], xpGained: progress.xpGained + gained, xpTotal: progress.xpTotal + gained };
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "xp-quests", userId, submissionId } });
    return progress;
  }
}

/** Days after the last goal and before today that nothing was open for this labeler. */
async function protectedDays(db: Db, userId: string, state: StreakState, today: string): Promise<Set<string>> {
  if (state.lastGoalDay === null) return new Set();
  const rows = await db.dailyProgress.findMany({
    where: { userId, protected: true, dayKey: { gt: state.lastGoalDay, lt: today } },
    select: { dayKey: true },
  });
  return new Set(rows.map((r) => r.dayKey));
}

/**
 * Record XP for an accepted answer or a passed quality check. Call it after the
 * answer's own write has committed. Recording the same submission again
 * awards nothing and returns the labeler's progress as it stands. #202: then
 * evaluates the tier and stamps, once per answer.
 */
export async function recordAccepted(answer: AcceptedAnswer): Promise<Progress> {
  const { userId, submissionId, difficulty, isQualityCheck, at = new Date() } = answer;
  const dayKey = manilaDayKey(at);
  const weekKey = manilaWeekKey(at);

  let recorded: { progress: Omit<Progress, "tier" | "stampsAwarded">; stored: TierStatus };
  try {
    recorded = await prisma.$transaction(async (tx) => {
      const lines: ProgressLine[] = [];
      const award = async (kind: XpKind, amount: number, dedupeKey: string, forSubmission: string | null) => {
        await tx.xpEvent.create({
          data: { userId, kind, amount, submissionId: forSubmission, dedupeKey, dayKey, weekKey },
        });
        lines.push({ kind, amount });
      };

      // A duplicate here rolls the whole award back, so the day's count below
      // moves once per submission. Only this row's key means "already
      // recorded"; any other unique violation is a real failure and is thrown.
      try {
        if (isQualityCheck) await award("QUALITY_CHECK", QUALITY_CHECK_XP, `check:${submissionId}`, submissionId);
        else await award("ANSWER", answerXp(difficulty), `answer:${submissionId}`, submissionId);
      } catch (err) {
        throw isUniqueViolation(err) ? new AlreadyRecorded() : err;
      }

      // The increment locks the day's row until commit, so concurrent answers
      // see distinct counts and only one sees exactly the goal.
      const day = await tx.dailyProgress.upsert({
        where: { userId_dayKey: { userId, dayKey } },
        create: { userId, dayKey, counted: 1 },
        update: { counted: { increment: 1 } },
      });

      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: streakSelect });
      const goalJustMet = day.counted === DAILY_GOAL;
      let streak: Progress["streak"];
      let state: StreakState = user;

      if (goalJustMet) {
        await award("DAILY_GOAL", DAILY_GOAL_XP, `goal:${userId}:${dayKey}`, null);
        await tx.dailyProgress.update({ where: { userId_dayKey: { userId, dayKey } }, data: { goalMet: true } });

        const covered = await protectedDays(tx, userId, user, dayKey);
        const s = settleStreak(user, dayKey, (d) => covered.has(d));
        state = s.state;
        if (s.milestoneXp > 0) await award("STREAK_MILESTONE", s.milestoneXp, `streak:${userId}:${dayKey}`, null);
        for (const restDay of s.restUsedDays) {
          await tx.dailyProgress.upsert({
            where: { userId_dayKey: { userId, dayKey: restDay } },
            create: { userId, dayKey: restDay, restUsed: true },
            update: { restUsed: true },
          });
        }
        streak = {
          days: state.streakDays,
          best: state.bestStreak,
          restDays: state.restDays,
          restEarned: s.restEarned,
          restUsed: s.restUsedDays.length,
          endedAtDays: s.endedAtDays,
        };
      } else {
        const covered = await protectedDays(tx, userId, user, dayKey);
        const e = effectiveStreak(user, dayKey, (d) => covered.has(d));
        streak = { days: e.days, best: user.bestStreak, restDays: e.restDays, restEarned: false, restUsed: 0, endedAtDays: null };
      }

      const xpGained = lines.reduce((sum, l) => sum + l.amount, 0);
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          xp: { increment: xpGained },
          streakDays: state.streakDays,
          bestStreak: state.bestStreak,
          restDays: state.restDays,
          lastGoalDay: state.lastGoalDay,
        },
        select: { xp: true, ...tierSelect },
      });

      return {
        progress: {
          lines,
          xpGained,
          xpTotal: updated.xp,
          today: { counted: day.counted, goal: DAILY_GOAL, goalMet: day.counted >= DAILY_GOAL, goalJustMet },
          streak,
        },
        stored: tierAsStored(updated),
      };
    });
  } catch (err) {
    if (!(err instanceof AlreadyRecorded)) throw err;
    return currentProgress(userId, dayKey);
  }
  return withStanding(await withQuests(recorded.progress, answer), recorded.stored, answer);
}

/** Progress as it stands, with nothing gained: the answer was already recorded. */
async function currentProgress(userId: string, dayKey: string): Promise<Progress> {
  const [user, day] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { ...streakSelect, ...tierSelect } }),
    prisma.dailyProgress.findUnique({ where: { userId_dayKey: { userId, dayKey } } }),
  ]);
  const covered = await protectedDays(prisma, userId, user, dayKey);
  const e = effectiveStreak(user, dayKey, (d) => covered.has(d));
  const counted = day?.counted ?? 0;
  return {
    lines: [],
    xpGained: 0,
    xpTotal: user.xp,
    today: { counted, goal: DAILY_GOAL, goalMet: day?.goalMet ?? false, goalJustMet: false },
    streak: { days: e.days, best: user.bestStreak, restDays: e.restDays, restEarned: false, restUsed: 0, endedAtDays: null },
    tier: tierAsStored(user),
    stampsAwarded: [],
  };
}

/** Nothing is open for this labeler today, so today can't break their streak. */
export async function markProtected(userId: string, at: Date = new Date()): Promise<void> {
  const dayKey = manilaDayKey(at);
  await prisma.dailyProgress.upsert({
    where: { userId_dayKey: { userId, dayKey } },
    create: { userId, dayKey, protected: true },
    update: { protected: true },
  });
}

/** The labeler's XP, today and week; null when the account no longer exists. */
export async function readProgress(userId: string, at: Date = new Date()): Promise<ProgressSummary | null> {
  const today = manilaDayKey(at);
  const weekKey = weekKeyOf(today);
  const days = weekDayKeys(weekKey);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...streakSelect, createdAt: true },
  });
  if (!user) return null;
  const [weekXp, rows, covered] = await Promise.all([
    prisma.xpEvent.aggregate({ where: { userId, weekKey }, _sum: { amount: true } }),
    prisma.dailyProgress.findMany({ where: { userId, dayKey: { gte: days[0], lte: days[6] } } }),
    protectedDays(prisma, userId, user, today),
  ]);
  const byDay = new Map(rows.map((r) => [r.dayKey, r]));
  const e = effectiveStreak(user, today, (d) => covered.has(d));
  const restCovered = new Set(e.restUsedDays);
  const joined = manilaDayKey(user.createdAt);

  const week = days.map((dayKey) => {
    const row = byDay.get(dayKey);
    let status: WeekDayStatus;
    if (row?.goalMet) status = "met";
    else if (dayKey === today) status = "today";
    else if (dayKey > today || dayKey < joined) status = "open";
    else if (row?.protected) status = "protected";
    else if (row?.restUsed || restCovered.has(dayKey)) status = "rest";
    else status = "missed";
    return { dayKey, status };
  });

  const todayRow = byDay.get(today);
  return {
    xpTotal: user.xp,
    xpThisWeek: weekXp._sum.amount ?? 0,
    today: { dayKey: today, counted: todayRow?.counted ?? 0, goal: DAILY_GOAL, goalMet: todayRow?.goalMet ?? false },
    week,
    streak: { days: e.days, best: user.bestStreak, restDays: e.restDays, endedAtDays: e.endedAtDays },
  };
}
