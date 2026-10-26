import { describe, it, expect } from "vitest";
import {
  answerXp,
  effectiveStreak,
  settleStreak,
  STREAK_MILESTONES,
  type StreakState,
} from "../rules";

const fresh: StreakState = { streakDays: 0, bestStreak: 0, restDays: 0, lastGoalDay: null };
const never = () => false;

/** Meet the goal on each of `days` consecutive days ending on `today`. */
function runOf(days: number, today: string, from: StreakState = fresh): StreakState {
  let state = from;
  const start = new Date(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - i);
    state = settleStreak(state, d.toISOString().slice(0, 10), never).state;
  }
  return state;
}

describe("answerXp", () => {
  it.each([
    [1, 10],
    [3, 10],
    [4, 15],
    [6, 15],
    [7, 20],
    [9, 20],
  ])("difficulty %i pays %i", (difficulty, xp) => {
    expect(answerXp(difficulty)).toBe(xp);
  });

  it("pays the lowest band when difficulty is unknown", () => {
    expect(answerXp(null)).toBe(10);
  });
});

describe("settleStreak", () => {
  it("starts a streak on the first goal ever", () => {
    const r = settleStreak(fresh, "2026-10-12", never);
    expect(r.state).toEqual({ streakDays: 1, bestStreak: 1, restDays: 0, lastGoalDay: "2026-10-12" });
    expect(r.alreadyMet).toBe(false);
    expect(r.milestoneXp).toBe(0);
  });

  it("does nothing when today is already met", () => {
    const met: StreakState = { streakDays: 4, bestStreak: 4, restDays: 0, lastGoalDay: "2026-10-12" };
    const r = settleStreak(met, "2026-10-12", never);
    expect(r.alreadyMet).toBe(true);
    expect(r.state).toEqual(met);
  });

  it("extends across consecutive days", () => {
    const r = settleStreak(
      { streakDays: 1, bestStreak: 1, restDays: 0, lastGoalDay: "2026-10-11" },
      "2026-10-12",
      never,
    );
    expect(r.state.streakDays).toBe(2);
    expect(r.ended).toBe(false);
  });

  it("covers a missed day with a rest day", () => {
    const r = settleStreak(
      { streakDays: 10, bestStreak: 10, restDays: 1, lastGoalDay: "2026-10-10" },
      "2026-10-12",
      never,
    );
    expect(r.state).toEqual({ streakDays: 11, bestStreak: 11, restDays: 0, lastGoalDay: "2026-10-12" });
    expect(r.restUsedDays).toEqual(["2026-10-11"]);
  });

  it("skips a protected day without spending a rest day", () => {
    const r = settleStreak(
      { streakDays: 5, bestStreak: 5, restDays: 1, lastGoalDay: "2026-10-10" },
      "2026-10-12",
      (d) => d === "2026-10-11",
    );
    expect(r.state.streakDays).toBe(6);
    expect(r.state.restDays).toBe(1);
    expect(r.restUsedDays).toEqual([]);
  });

  it("mixes protected and rest-covered days in one gap", () => {
    const r = settleStreak(
      { streakDays: 9, bestStreak: 9, restDays: 2, lastGoalDay: "2026-10-08" },
      "2026-10-12",
      (d) => d === "2026-10-10",
    );
    expect(r.state.streakDays).toBe(10);
    expect(r.state.restDays).toBe(0);
    expect(r.restUsedDays).toEqual(["2026-10-09", "2026-10-11"]);
  });

  it("breaks when the gap is longer than the rest days held, and spends none", () => {
    const r = settleStreak(
      { streakDays: 11, bestStreak: 11, restDays: 1, lastGoalDay: "2026-10-09" },
      "2026-10-12",
      never,
    );
    expect(r.ended).toBe(true);
    expect(r.endedAtDays).toBe(11);
    expect(r.restUsedDays).toEqual([]);
    expect(r.state).toEqual({ streakDays: 1, bestStreak: 11, restDays: 1, lastGoalDay: "2026-10-12" });
  });

  it("pays milestones at 3, 7, 14 and 30 days only", () => {
    const paid: Record<number, number> = {};
    let state = fresh;
    for (let day = 1; day <= 31; day++) {
      const key = `2026-10-${String(day).padStart(2, "0")}`;
      const r = settleStreak(state, key, never);
      if (r.milestoneXp > 0) paid[r.state.streakDays] = r.milestoneXp;
      state = r.state;
    }
    expect(paid).toEqual({ 3: 25, 7: 50, 14: 100, 30: 200 });
    expect(STREAK_MILESTONES).toEqual({ 3: 25, 7: 50, 14: 100, 30: 200 });
  });

  it("earns a rest day every 7 streak days, capped at 2", () => {
    const at6 = runOf(6, "2026-10-06");
    expect(at6.restDays).toBe(0);

    const seventh = settleStreak(at6, "2026-10-07", never);
    expect(seventh.state.restDays).toBe(1);
    expect(seventh.restEarned).toBe(true);

    const at14 = runOf(7, "2026-10-14", seventh.state);
    expect(at14.restDays).toBe(2);

    const at20 = runOf(6, "2026-10-20", at14);
    const at21 = settleStreak(at20, "2026-10-21", never);
    expect(at21.state.restDays).toBe(2);
    expect(at21.restEarned).toBe(false);
  });
});

describe("effectiveStreak", () => {
  it("is the stored streak when the goal was met yesterday", () => {
    const s: StreakState = { streakDays: 6, bestStreak: 6, restDays: 0, lastGoalDay: "2026-10-11" };
    expect(effectiveStreak(s, "2026-10-12", never)).toEqual({
      days: 6,
      restDays: 0,
      restUsedDays: [],
      ended: false,
      endedAtDays: null,
    });
  });

  it("does not let today break the streak before the day is over", () => {
    const s: StreakState = { streakDays: 6, bestStreak: 6, restDays: 0, lastGoalDay: "2026-10-11" };
    expect(effectiveStreak(s, "2026-10-12", never).ended).toBe(false);
  });

  it("reads a rest-covered gap as intact, with the rest day spent", () => {
    const s: StreakState = { streakDays: 11, bestStreak: 11, restDays: 1, lastGoalDay: "2026-10-10" };
    expect(effectiveStreak(s, "2026-10-12", never)).toEqual({
      days: 11,
      restDays: 0,
      restUsedDays: ["2026-10-11"],
      ended: false,
      endedAtDays: null,
    });
  });

  it("reads an uncoverable gap as ended, keeping rest days", () => {
    const s: StreakState = { streakDays: 11, bestStreak: 11, restDays: 1, lastGoalDay: "2026-10-09" };
    expect(effectiveStreak(s, "2026-10-12", never)).toEqual({
      days: 0,
      restDays: 1,
      restUsedDays: [],
      ended: true,
      endedAtDays: 11,
    });
  });

  it("is zero, not ended, for someone who never met a goal", () => {
    expect(effectiveStreak(fresh, "2026-10-12", never)).toEqual({
      days: 0,
      restDays: 0,
      restUsedDays: [],
      ended: false,
      endedAtDays: null,
    });
  });
});
