// #201 — PostHog events for an answer's progress: counts and kinds only.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { track } from "@/lib/analytics";
import { trackProgress } from "../analytics";
import type { Progress } from "../types";

const base: Progress = {
  lines: [{ kind: "ANSWER", amount: 15 }],
  xpGained: 15,
  xpTotal: 15,
  today: { counted: 1, goal: 5, goalMet: false, goalJustMet: false },
  streak: { days: 0, best: 0, restDays: 0, restEarned: false, restUsed: 0, endedAtDays: null },
  tier: { tier: 0, onHold: false, tierUp: null, holdChecksPassed: 0 },
  stampsAwarded: [],
};

beforeEach(() => vi.mocked(track).mockReset());

const calls = () => vi.mocked(track).mock.calls;

describe("trackProgress", () => {
  it("sends one xp_awarded per line and nothing else on an ordinary answer", () => {
    trackProgress(base);
    expect(calls()).toEqual([["xp_awarded", { kind: "ANSWER", amount: 15 }]]);
  });

  it("sends the goal, the extension, a used rest day and an ended streak", () => {
    trackProgress({
      ...base,
      lines: [
        { kind: "ANSWER", amount: 15 },
        { kind: "DAILY_GOAL", amount: 20 },
      ],
      today: { counted: 5, goal: 5, goalMet: true, goalJustMet: true },
      streak: { days: 8, best: 8, restDays: 0, restEarned: false, restUsed: 1, endedAtDays: null },
    });
    expect(calls()).toEqual([
      ["xp_awarded", { kind: "ANSWER", amount: 15 }],
      ["xp_awarded", { kind: "DAILY_GOAL", amount: 20 }],
      ["rest_day_used"],
      ["daily_goal_met", { streak_days: 8 }],
      ["streak_extended", { streak_days: 8 }],
    ]);
  });

  it("reports an ended streak and does not call a new one extended", () => {
    trackProgress({
      ...base,
      today: { counted: 5, goal: 5, goalMet: true, goalJustMet: true },
      streak: { days: 1, best: 11, restDays: 0, restEarned: false, restUsed: 0, endedAtDays: 11 },
    });
    expect(calls()).toContainEqual(["streak_ended", { ended_at_days: 11 }]);
    expect(calls()).toContainEqual(["daily_goal_met", { streak_days: 1 }]);
    expect(calls().map((c) => c[0])).not.toContain("streak_extended");
  });
});
