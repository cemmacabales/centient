// #201 — the XP loop's UI pieces, rendered to static markup as the TaskCard
// tests do (no jsdom). Assertions are on copy, roles and states, not classes.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WeekCard from "../WeekCard";
import AcceptedStub from "../AcceptedStub";
import TodayStrip from "../TodayStrip";
import { restLine, todayLine, weekdayName } from "../format";
import type { Progress, ProgressSummary, WeekDayStatus } from "@/lib/gamification/types";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

function summary(statuses: WeekDayStatus[], overrides: Partial<ProgressSummary> = {}): ProgressSummary {
  const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
  return {
    xpTotal: 930,
    xpThisWeek: 120,
    today: { dayKey: "2026-10-15", counted: 4, goal: 5, goalMet: false },
    week: days.map((dayKey, i) => ({ dayKey, status: statuses[i] })),
    streak: { days: 6, best: 6, restDays: 0, endedAtDays: null },
    ...overrides,
  };
}

const progress = (overrides: Partial<Progress> = {}): Progress => ({
  lines: [{ kind: "ANSWER", amount: 15 }],
  xpGained: 15,
  xpTotal: 1015,
  today: { counted: 2, goal: 5, goalMet: false, goalJustMet: false },
  streak: { days: 6, best: 6, restDays: 0, restEarned: false, restUsed: 0, endedAtDays: null },
  tier: { tier: 0, onHold: false, tierUp: null, holdChecksPassed: 0 },
  stampsAwarded: [],
  ...overrides,
});

describe("format", () => {
  it("says how far today is from the goal and what it decides", () => {
    expect(todayLine(4, false, 6)).toBe("Today 4 of 5. One more keeps your streak.");
    expect(todayLine(2, false, 6)).toBe("Today 2 of 5. 3 more keep your streak.");
    expect(todayLine(0, false, 0)).toBe("Today 0 of 5. 5 more start a streak.");
    expect(todayLine(4, false, 0)).toBe("Today 4 of 5. One more starts a streak.");
    expect(todayLine(7, true, 7)).toBe("Today 5 of 5. Goal met.");
  });

  it("says the rest days held, or when the next one comes", () => {
    expect(restLine(0, 6)).toBe("Rest day at 7");
    expect(restLine(0, 7)).toBe("Rest day at 14");
    expect(restLine(1, 9)).toBe("1 rest day");
    expect(restLine(2, 14)).toBe("2 rest days");
  });

  it("names Manila weekdays", () => {
    expect(weekdayName("2026-10-16")).toBe("Friday");
  });
});

describe("WeekCard", () => {
  it("shows the week, the streak and today's tally", () => {
    const html = renderToStaticMarkup(
      createElement(WeekCard, { progress: summary(["met", "met", "met", "today", "open", "open", "open"]) }),
    );
    expect(text(html)).toContain("This week");
    expect(text(html)).toContain("6-day streak");
    expect(text(html)).toContain("Today 4 of 5. One more keeps your streak.");
    expect(text(html)).toContain("Rest day at 7");
    expect(html).toContain('aria-label="Monday: goal met"');
    expect(html).toContain('aria-label="Thursday: today"');
    expect(text(html)).toContain("4/5");
  });

  it("says which missed day a rest day covered", () => {
    const html = renderToStaticMarkup(
      createElement(WeekCard, {
        progress: summary(["met", "met", "met", "met", "rest", "today", "open"], {
          today: { dayKey: "2026-10-17", counted: 1, goal: 5, goalMet: false },
          streak: { days: 11, best: 11, restDays: 0, endedAtDays: null },
        }),
      }),
    );
    expect(html).toContain('aria-label="Friday: covered by a rest day"');
    expect(text(html)).toContain("You missed Friday, so a rest day covered it. Your streak is 11 days.");
  });

  it("says a streak ended plainly, with no streak count", () => {
    const html = renderToStaticMarkup(
      createElement(WeekCard, {
        progress: summary(["met", "missed", "missed", "today", "open", "open", "open"], {
          today: { dayKey: "2026-10-15", counted: 0, goal: 5, goalMet: false },
          streak: { days: 0, best: 11, restDays: 0, endedAtDays: 11 },
        }),
      }),
    );
    expect(text(html)).toContain("Your streak ended at 11 days.");
    expect(text(html)).toContain("Meet today's goal to start a new one. Your XP doesn't change.");
    expect(text(html)).not.toContain("-day streak");
  });
});

describe("AcceptedStub", () => {
  const at = new Date("2026-10-15T12:42:00Z");

  it("itemizes the reward in USDC and the answer's XP", () => {
    const t = text(renderToStaticMarkup(createElement(AcceptedStub, { progress: progress(), reward: "0.75", symbol: "USDC", at })));
    expect(t).toContain("Answer accepted");
    expect(t).toContain("Reward 0.75 USDC");
    expect(t).toContain("Payout Pending");
    expect(t).toContain("XP +15");
    expect(t).toContain("Total XP 1,015");
    expect(t).not.toContain("Daily goal");
    expect(t).not.toContain("Rest day earned");
  });

  it("adds the goal, the milestone and an earned rest day when they happen", () => {
    const t = text(
      renderToStaticMarkup(
        createElement(AcceptedStub, {
          progress: progress({
            lines: [
              { kind: "ANSWER", amount: 15 },
              { kind: "DAILY_GOAL", amount: 20 },
              { kind: "STREAK_MILESTONE", amount: 50 },
            ],
            today: { counted: 5, goal: 5, goalMet: true, goalJustMet: true },
            streak: { days: 7, best: 7, restDays: 1, restEarned: true, restUsed: 0, endedAtDays: null },
          }),
          reward: "0.75",
          symbol: "USDC",
          at,
        }),
      ),
    );
    expect(t).toContain("Daily goal, 5 of 5 +20");
    expect(t).toContain("7-day streak +50");
    expect(t).toContain("Rest day earned. It covers one missed day.");
  });
});

describe("TodayStrip", () => {
  it("shows today's count as a progressbar, with the streak", () => {
    const html = renderToStaticMarkup(createElement(TodayStrip, { counted: 4, streakDays: 6 }));
    expect(text(html)).toContain("Today 4 of 5");
    expect(text(html)).toContain("6-day streak");
    expect(html).toContain('aria-valuenow="4"');
  });

  it("caps the count at the goal and hides a zero streak", () => {
    const html = renderToStaticMarkup(createElement(TodayStrip, { counted: 8, streakDays: 0 }));
    expect(text(html)).toContain("Today 5 of 5");
    expect(text(html)).not.toContain("streak");
  });
});

describe("TaskCard's XP pill follows NEXT_PUBLIC_GAMIFICATION", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function pill(flag: string | undefined) {
    vi.resetModules();
    if (flag !== undefined) vi.stubEnv("NEXT_PUBLIC_GAMIFICATION", flag);
    const { TaskCardView } = await import("@/components/TaskCard");
    const noop = () => {};
    return text(
      renderToStaticMarkup(
        createElement(TaskCardView, {
          task: { id: "t", prompt: "p", responseA: "a", responseB: "b" },
          choice: null,
          reason: "",
          loading: false,
          error: null,
          reward: "0.75",
          tokenSymbol: "USDC",
          xp: 15,
          onChoose: noop,
          onReasonChange: noop,
          onSubmit: noop,
        }),
      ),
    );
  }

  it("shows +XP beside the reward when on", async () => {
    expect(await pill("on")).toContain("0.75 USDC +15 XP");
  });

  it("is unchanged when off", async () => {
    const t = await pill(undefined);
    expect(t).toContain("0.75 USDC");
    expect(t).not.toContain("XP");
  });
});
