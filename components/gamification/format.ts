import { DAILY_GOAL } from "@/lib/gamification/types";

const XP = new Intl.NumberFormat("en-US");

/** XP with thousands separators: 1,015. */
export function formatXp(n: number): string {
  return XP.format(n);
}

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INITIAL = ["S", "M", "T", "W", "T", "F", "S"];

function weekday(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

/** "Friday", for a Manila day key. */
export function weekdayName(dayKey: string): string {
  return WEEKDAY_LONG[weekday(dayKey)];
}

/** "F", for a Manila day key. */
export function weekdayInitial(dayKey: string): string {
  return WEEKDAY_INITIAL[weekday(dayKey)];
}

/** The tally under the week: how far today is from the goal, and what it decides. */
export function todayLine(counted: number, goalMet: boolean, streakDays: number): string {
  const head = `Today ${Math.min(counted, DAILY_GOAL)} of ${DAILY_GOAL}.`;
  if (goalMet) return `${head} Goal met.`;
  const left = DAILY_GOAL - counted;
  const more = left === 1 ? "One more" : `${left} more`;
  if (streakDays > 0) return `${head} ${more} ${left === 1 ? "keeps" : "keep"} your streak.`;
  return `${head} ${more} ${left === 1 ? "starts" : "start"} a streak.`;
}

/** The week card's right-hand note: rest days held, or when the next one comes. */
export function restLine(restDays: number, streakDays: number): string {
  if (restDays > 0) return `${restDays} rest day${restDays === 1 ? "" : "s"}`;
  return `Rest day at ${(Math.floor(streakDays / 7) + 1) * 7}`;
}
