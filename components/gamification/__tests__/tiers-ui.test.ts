// #202 — the tier UI, rendered to static markup like the #201 pieces: the tier
// card (Home and Progress), the hold card, the tier-up receipt, the stamp grid
// and the task's tier chip. Assertions are on copy, roles and states.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TierCard from "../TierCard";
import OnHoldCard from "../OnHoldCard";
import TierUpReceipt from "../TierUpReceipt";
import StampGrid from "../StampGrid";
import { holdLine, keepOpenLine, nextLine, payRange, stampCaption } from "../tier-format";
import { STAMPS } from "@/lib/gamification/stamps";
import type { StampStatus, TierSummary } from "@/lib/gamification/types";

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function tier(over: Partial<TierSummary> = {}): TierSummary {
  return {
    tier: 1,
    name: "Skilled",
    onHold: false,
    holdChecksPassed: 0,
    reopenAfter: 3,
    checks: { passed: 9, total: 10 },
    crowd: { matched: 37, total: 50 },
    activeDays: 9,
    answers: 53,
    band: { difficulty: "4–5", tasks: 132, payFrom: "0.4", payTo: "1.15", xp: "15" },
    next: { tier: 2, name: "Trusted", xp: 1500, xpToGo: 570, payUpTo: "1.45" },
    ...over,
  };
}

describe("tier-format", () => {
  it("says what the next tier needs and what it pays", () => {
    expect(nextLine(tier())).toBe("570 XP to Trusted. It opens tasks that pay up to 1.45 USDC.");
    expect(nextLine(tier({ next: { tier: 2, name: "Trusted", xp: 1500, xpToGo: 570, payUpTo: null } }))).toBe(
      "570 XP to Trusted.",
    );
    expect(nextLine(tier({ next: { tier: 2, name: "Trusted", xp: 1500, xpToGo: 0, payUpTo: "1.45" } }))).toBe(
      "You have the XP for Trusted. Keep your quality checks at 85%+ and crowd match at 70%+ to open it.",
    );
    expect(nextLine(tier({ tier: 3, name: "Expert", next: null }))).toBe("Expert is the top tier. Every task is open to you.");
  });

  it("states each tier's keep-it-open rule", () => {
    expect(keepOpenLine(1)).toBe("Quality checks 80%+");
    expect(keepOpenLine(2)).toBe("Checks 85%+ · crowd 70%+");
    expect(keepOpenLine(3)).toBe("Checks 90%+ · crowd 75%+");
  });

  it("formats a pay range in USDC to the cent", () => {
    expect(payRange("0.4", "1.15")).toBe("0.40–1.15");
    expect(payRange("1.45", "1.45")).toBe("1.45");
    expect(payRange(null, null)).toBeNull();
  });

  it("says why a tier is on hold and how to reopen it", () => {
    expect(holdLine(tier({ tier: 2, name: "Trusted", onHold: true, checks: { passed: 7, total: 10 } }))).toBe(
      "Your quality checks dropped to 7 of the last 10. Pass the next 3 to reopen Trusted tasks. Your XP and tier stay.",
    );
    expect(
      holdLine(tier({ tier: 2, name: "Trusted", onHold: true, checks: { passed: 10, total: 10 }, crowd: { matched: 33, total: 50 } })),
    ).toBe("Your crowd match dropped to 66%. Pass the next 3 quality checks to reopen Trusted tasks. Your XP and tier stay.");
  });
});

describe("TierCard on Home", () => {
  it("shows the tier, the four discs, XP toward the next tier and what it pays", () => {
    const html = renderToStaticMarkup(createElement(TierCard, { tier: tier(), xpTotal: 930 }));
    const t = text(html);
    expect(t).toContain("Tier Skilled");
    expect(t).toContain("930 XP");
    expect(t).toContain("1,500 for Trusted");
    expect(t).toContain("570 XP to Trusted. It opens tasks that pay up to 1.45 USDC");
    expect(html).toContain('aria-label="Tier 2 of 4"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="930"');
    expect(html).toContain('aria-valuemax="1500"');
  });

  it("shows no bar at Expert", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { tier: tier({ tier: 3, name: "Expert", next: null }), xpTotal: 4210 }),
    );
    expect(html).not.toContain('role="progressbar"');
    expect(text(html)).toContain("4,210 XP");
    expect(text(html)).toContain("Expert is the top tier.");
  });
});

describe("TierCard on Progress", () => {
  it("adds the checks, crowd, answers and streak as receipt rows", () => {
    const t = text(
      renderToStaticMarkup(
        createElement(TierCard, {
          tier: tier({ next: { tier: 2, name: "Trusted", xp: 1500, xpToGo: 485, payUpTo: "1.45" } }),
          xpTotal: 1015,
          detail: { streakDays: 7, restDays: 1 },
        }),
      ),
    );
    expect(t).toContain("485 to Trusted");
    expect(t).toContain("Quality checks 9 of last 10");
    expect(t).toContain("Matched the crowd 74%");
    expect(t).toContain("Answers 53");
    expect(t).toContain("Streak 7 days · 1 rest day");
  });

  it("says plainly when there's nothing to judge yet", () => {
    const t = text(
      renderToStaticMarkup(
        createElement(TierCard, {
          tier: tier({ checks: { passed: 0, total: 0 }, crowd: { matched: 0, total: 0 }, answers: 0 }),
          xpTotal: 0,
          detail: { streakDays: 0, restDays: 0 },
        }),
      ),
    );
    expect(t).toContain("Quality checks None yet");
    expect(t).toContain("Matched the crowd None yet");
    expect(t).toContain("Streak None yet");
  });
});

describe("OnHoldCard", () => {
  it("pauses the tier's tasks with the 3-dot progress, never in error red", () => {
    const html = renderToStaticMarkup(
      createElement(OnHoldCard, {
        tier: tier({ tier: 2, name: "Trusted", onHold: true, holdChecksPassed: 1, checks: { passed: 7, total: 10 } }),
      }),
    );
    const t = text(html);
    expect(t).toContain("Trusted tasks paused");
    expect(t).toContain("Pass the next 3 to reopen Trusted tasks.");
    expect(t).toContain("1 of 3 passed");
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/error/);
  });
});

describe("TierUpReceipt", () => {
  it("lists what the new tier opened", () => {
    const t = text(renderToStaticMarkup(createElement(TierUpReceipt, { tier: tier() })));
    expect(t).toContain("Now open to you");
    expect(t).toContain("New tasks 132");
    expect(t).toContain("Difficulty 4–5");
    expect(t).toContain("They pay 0.40–1.15 USDC");
    expect(t).toContain("XP per answer 15");
    expect(t).toContain("Keep it open Quality checks 80%+");
  });

  it("leaves out the pay line when nothing in the band is open", () => {
    const t = text(
      renderToStaticMarkup(
        createElement(TierUpReceipt, {
          tier: tier({ band: { difficulty: "4–5", tasks: 0, payFrom: null, payTo: null, xp: "15" } }),
        }),
      ),
    );
    expect(t).toContain("New tasks 0");
    expect(t).not.toContain("They pay");
  });
});

describe("StampGrid", () => {
  const now = new Date("2026-10-15T04:00:00Z");
  const status = (id: string, over: Partial<StampStatus> = {}): StampStatus => ({ id, awardedAt: null, progress: null, ...over });
  const all: StampStatus[] = STAMPS.map((s) => status(s.id, { progress: s.goal ? { current: 0, target: s.goal.target } : null }));

  it("captions earned stamps with their date and locked ones with progress", () => {
    expect(stampCaption("first-answer", status("first-answer", { awardedAt: "2026-10-02T03:00:00Z" }), now)).toBe("2 Oct");
    expect(stampCaption("answers-250", status("answers-250", { progress: { current: 53, target: 250 } }), now)).toBe("53 / 250");
    expect(stampCaption("in-step", status("in-step", { progress: { current: 18, target: 25 } }), now)).toBe("Matched 18 / 25");
    expect(stampCaption("all-rounder", status("all-rounder", { progress: { current: 4, target: 6 } }), now)).toBe("4 / 6 topics");
    expect(stampCaption("event", status("event"), now)).toBe("Event code");
    expect(stampCaption("top-3-week", status("top-3-week"), now)).toBe("Weekly top 3");
  });

  it("says Today for a stamp earned today, Manila time", () => {
    expect(stampCaption("streak-7", status("streak-7", { awardedAt: "2026-10-14T17:00:00Z" }), now)).toBe("Today");
  });

  it("puts earned stamps first and marks one earned today as new", () => {
    const stamps = all.map((s) =>
      s.id === "first-answer"
        ? { ...s, awardedAt: "2026-10-02T03:00:00Z" }
        : s.id === "streak-7"
          ? { ...s, awardedAt: "2026-10-15T01:00:00Z" }
          : s,
    );
    const html = renderToStaticMarkup(createElement(StampGrid, { stamps, now }));
    const t = text(html);
    expect(t.indexOf("First answer")).toBeLessThan(t.indexOf("50 answers"));
    expect(t.indexOf("7-day streak")).toBeLessThan(t.indexOf("50 answers"));
    expect(t).toContain("7-day streak Today");
    expect(html).toMatch(/>New<\/span>/);
    expect(html).toContain('aria-label="First answer, earned 2 Oct"');
    expect(html).toContain('aria-label="250 answers, locked: Get 250 answers accepted. 0 / 250"');
  });
});

describe("TaskCard's tier chip (#202)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function card(flag: string | undefined, taskTier: number | undefined) {
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
          tier: taskTier,
          onChoose: noop,
          onReasonChange: noop,
          onSubmit: noop,
        }),
      ),
    );
  }

  it("names a task above Starter by its tier", async () => {
    expect(await card("on", 1)).toContain("The Prompt lock_open Skilled task");
    expect(await card("on", 2)).toContain("Trusted task");
  });

  it("shows nothing on a Starter task or one with no difficulty", async () => {
    expect(await card("on", 0)).not.toContain(" task p");
    expect(await card("on", undefined)).not.toContain("Skilled");
  });

  it("is unchanged when the flag is off", async () => {
    expect(await card(undefined, 2)).not.toContain("Trusted task");
  });
});

describe("AcceptedStub (#202, board 05)", () => {
  const at = new Date("2026-10-15T12:42:00Z");
  const base = {
    lines: [{ kind: "ANSWER" as const, amount: 15 }],
    xpGained: 15,
    xpTotal: 1015,
    today: { counted: 2, goal: 5 as const, goalMet: false, goalJustMet: false },
    streak: { days: 6, best: 6, restDays: 0, restEarned: false, restUsed: 0, endedAtDays: null },
    tier: { tier: 1, onHold: false, tierUp: null, holdChecksPassed: 0 },
    stampsAwarded: [] as string[],
  };

  it("reads XP toward the next tier", async () => {
    const { default: AcceptedStub } = await import("../AcceptedStub");
    const t = text(renderToStaticMarkup(createElement(AcceptedStub, { progress: base, reward: "0.75", symbol: "USDC", at })));
    expect(t).toContain("Toward Trusted 1,015 / 1,500 XP");
  });

  it("links a new stamp to Progress", async () => {
    const { default: AcceptedStub } = await import("../AcceptedStub");
    const t = text(
      renderToStaticMarkup(
        createElement(AcceptedStub, {
          progress: { ...base, stampsAwarded: ["streak-7"] },
          reward: "0.75",
          symbol: "USDC",
          at,
          onSeeStamp: () => {},
        }),
      ),
    );
    expect(t).toContain("7-day streak See your new stamp");
  });
});
