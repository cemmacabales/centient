import { describe, it, expect } from "vitest";
import { newlyEarned, stampProgress, STAMP_RULES, STAMPS, type StampStats } from "../stamps";

const zero: StampStats = {
  answers: 0,
  payouts: 0,
  bestStreak: 0,
  checkRun: 0,
  crowdMatches: 0,
  categories: 0,
  healthAnswers: 0,
};

function stats(over: Partial<StampStats>): StampStats {
  return { ...zero, ...over };
}

const byId = (id: string) => {
  const s = STAMPS.find((d) => d.id === id);
  if (!s) throw new Error(`no stamp ${id}`);
  return s;
};

describe("STAMPS", () => {
  it("defines the 14 stamps with unique ids", () => {
    expect(STAMPS).toHaveLength(14);
    expect(new Set(STAMPS.map((s) => s.id)).size).toBe(14);
  });

  it("awards every stamp: the event, invite and weekly ones through their own hooks (#203)", () => {
    expect(STAMPS.every((s) => s.earnable)).toBe(true);
    const hooked = STAMPS.filter((s) => s.goal === null).map((s) => s.id);
    expect(hooked.sort()).toEqual(["brought-a-friend", "event", "invited-in", "top-3-week"]);
  });

  it("keeps one generic Event slot; each code's own stamp is held beside it", () => {
    expect(byId("event")).toMatchObject({ title: "Event", icon: "festival" });
  });

  it("gives every stamp a title, an icon and its real criteria", () => {
    for (const s of STAMPS) {
      expect(s.title).not.toBe("");
      expect(s.icon).not.toBe("");
      expect(s.criteria).not.toBe("");
    }
  });
});

describe("newlyEarned", () => {
  it("awards nothing to a new labeler", () => {
    expect(newlyEarned(zero, new Set())).toEqual([]);
  });

  it.each<[string, Partial<StampStats>]>([
    ["first-answer", { answers: 1 }],
    ["first-payout", { payouts: 1 }],
    ["answers-50", { answers: 50 }],
    ["answers-250", { answers: 250 }],
    ["streak-7", { bestStreak: 7 }],
    ["streak-30", { bestStreak: 30 }],
    ["sharp-eye", { checkRun: STAMP_RULES.sharpEyeRun }],
    ["in-step", { crowdMatches: STAMP_RULES.inStepMatches }],
    ["all-rounder", { categories: STAMP_RULES.allRounderCategories }],
    ["health-specialist", { healthAnswers: STAMP_RULES.healthAnswers }],
  ])("awards %s at its threshold", (id, over) => {
    expect(newlyEarned(stats(over), new Set())).toContain(id);
  });

  it.each<[string, Partial<StampStats>]>([
    ["answers-50", { answers: 49 }],
    ["streak-7", { bestStreak: 6 }],
    ["sharp-eye", { checkRun: STAMP_RULES.sharpEyeRun - 1 }],
    ["in-step", { crowdMatches: STAMP_RULES.inStepMatches - 1 }],
    ["all-rounder", { categories: STAMP_RULES.allRounderCategories - 1 }],
    ["health-specialist", { healthAnswers: STAMP_RULES.healthAnswers - 1 }],
  ])("holds %s back one short", (id, over) => {
    expect(newlyEarned(stats(over), new Set())).not.toContain(id);
  });

  it("never awards a stamp the labeler already holds", () => {
    expect(newlyEarned(stats({ answers: 60 }), new Set(["first-answer"]))).toEqual(["answers-50"]);
  });

  it("never awards a hooked stamp from stats, however high", () => {
    const all = stats({
      answers: 1e6,
      payouts: 1e6,
      bestStreak: 1e6,
      checkRun: 1e6,
      crowdMatches: 1e6,
      categories: 1e6,
      healthAnswers: 1e6,
    });
    const earned = newlyEarned(all, new Set());
    expect(earned).toHaveLength(10);
    expect(earned).not.toContain("event");
    expect(earned).not.toContain("top-3-week");
  });
});

describe("stampProgress", () => {
  it("counts toward the target, capped at it", () => {
    expect(stampProgress(byId("answers-50"), stats({ answers: 12 }))).toEqual({ current: 12, target: 50 });
    expect(stampProgress(byId("answers-50"), stats({ answers: 80 }))).toEqual({ current: 50, target: 50 });
  });

  it("is null for a stamp no stat measures", () => {
    expect(stampProgress(byId("event"), zero)).toBeNull();
    expect(stampProgress(byId("top-3-week"), zero)).toBeNull();
  });
});
