// The XP loop's rules (#201, ADR-0010). Pure: no clock, no database. XP is
// never money: nothing here touches a reward amount or the payout rail.

import { dayKeysBetween } from "./time";

export { DAILY_GOAL } from "./types";
export const QUALITY_CHECK_XP = 5;
export const DAILY_GOAL_XP = 20;
export const STREAK_MILESTONES: Readonly<Record<number, number>> = { 3: 25, 7: 50, 14: 100, 30: 200 };
export const REST_DAY_EVERY = 7;
export const MAX_REST_DAYS = 2;

/** XP for an accepted answer, by the task's difficulty band (1–3, 4–6, 7–9). */
export function answerXp(difficulty: number | null): number {
  if (difficulty === null || difficulty <= 3) return 10;
  if (difficulty <= 6) return 15;
  return 20;
}

export interface StreakState {
  streakDays: number;
  bestStreak: number;
  restDays: number;
  /** Manila day key of the last day the goal was met. */
  lastGoalDay: string | null;
}

/** Whether nothing was open for the labeler on that day, so it can't break a streak. */
export type IsProtected = (dayKey: string) => boolean;

interface Gap {
  restUsedDays: string[];
  /** The gap needs more rest days than are held. */
  broken: boolean;
}

/**
 * The unprotected days between the last goal and `today` must each be covered
 * by a rest day. A gap that can't be covered in full breaks the streak and
 * spends none: rest days aren't burned on a streak that is ending anyway.
 */
function coverGap(state: StreakState, today: string, isProtected: IsProtected): Gap {
  if (state.lastGoalDay === null) return { restUsedDays: [], broken: false };
  const missed = dayKeysBetween(state.lastGoalDay, today).filter((d) => !isProtected(d));
  if (missed.length > state.restDays) return { restUsedDays: [], broken: true };
  return { restUsedDays: missed, broken: false };
}

export interface Settlement {
  state: StreakState;
  alreadyMet: boolean;
  restUsedDays: string[];
  /** A streak ended before today's goal started a new one. */
  ended: boolean;
  endedAtDays: number | null;
  milestoneXp: number;
  restEarned: boolean;
}

/** Settle the streak when today's goal is met. */
export function settleStreak(state: StreakState, today: string, isProtected: IsProtected): Settlement {
  if (state.lastGoalDay === today) {
    return { state, alreadyMet: true, restUsedDays: [], ended: false, endedAtDays: null, milestoneXp: 0, restEarned: false };
  }

  const gap = coverGap(state, today, isProtected);
  const ended = gap.broken && state.streakDays > 0;
  const streakDays = (gap.broken ? 0 : state.streakDays) + 1;
  let restDays = state.restDays - gap.restUsedDays.length;
  let restEarned = false;
  if (streakDays % REST_DAY_EVERY === 0 && restDays < MAX_REST_DAYS) {
    restDays += 1;
    restEarned = true;
  }

  return {
    state: {
      streakDays,
      bestStreak: Math.max(state.bestStreak, streakDays),
      restDays,
      lastGoalDay: today,
    },
    alreadyMet: false,
    restUsedDays: gap.restUsedDays,
    ended,
    endedAtDays: ended ? state.streakDays : null,
    milestoneXp: STREAK_MILESTONES[streakDays] ?? 0,
    restEarned,
  };
}

export interface EffectiveStreak {
  days: number;
  restDays: number;
  restUsedDays: string[];
  ended: boolean;
  endedAtDays: number | null;
}

/**
 * The streak as it stands on `today`, without writing anything. Today itself
 * can't break it: the day isn't over.
 */
export function effectiveStreak(state: StreakState, today: string, isProtected: IsProtected): EffectiveStreak {
  if (state.lastGoalDay === today) {
    return { days: state.streakDays, restDays: state.restDays, restUsedDays: [], ended: false, endedAtDays: null };
  }
  const gap = coverGap(state, today, isProtected);
  if (gap.broken && state.streakDays > 0) {
    return { days: 0, restDays: state.restDays, restUsedDays: [], ended: true, endedAtDays: state.streakDays };
  }
  return {
    days: state.streakDays,
    restDays: state.restDays - gap.restUsedDays.length,
    restUsedDays: gap.restUsedDays,
    ended: false,
    endedAtDays: null,
  };
}
