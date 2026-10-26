import { describe, it, expect } from "vitest";
import {
  evaluateTier,
  effectiveTier,
  maxDifficulty,
  nextTier,
  TIER_RULES,
  TIERS,
  type TierEvent,
  type TierSignals,
  type TierState,
} from "../tiers";

const starter: TierState = { tier: 0, onHold: false, holdChecksPassed: 0 };
const none: TierSignals = { xp: 0, checks: { passed: 0, total: 0 }, crowd: { matched: 0, total: 0 }, activeDays: 0 };

function signals(over: Partial<TierSignals>): TierSignals {
  return { ...none, ...over };
}

function at(tier: number, over: Partial<TierState> = {}): TierState {
  return { tier, onHold: false, holdChecksPassed: 0, ...over };
}

const strong: Pick<TierSignals, "checks" | "crowd"> = {
  checks: { passed: 10, total: 10 },
  crowd: { matched: 50, total: 50 },
};

describe("TIERS", () => {
  it("names the four tiers in order with their XP", () => {
    expect(TIERS.map((t) => [t.name, t.xp])).toEqual([
      ["Starter", 0],
      ["Skilled", 250],
      ["Trusted", 1500],
      ["Expert", 4000],
    ]);
  });
});

describe("maxDifficulty", () => {
  it.each([
    [0, 3],
    [1, 5],
    [2, 7],
    [3, 9],
  ])("tier %i serves up to difficulty %i", (tier, cap) => {
    expect(maxDifficulty(tier, false)).toBe(cap);
  });

  it.each([
    [1, 3],
    [2, 5],
    [3, 7],
  ])("tier %i on hold drops to the band below, %i", (tier, cap) => {
    expect(maxDifficulty(tier, true)).toBe(cap);
  });

  it("never drops Starter below its own band", () => {
    expect(maxDifficulty(0, true)).toBe(3);
  });
});

describe("effectiveTier", () => {
  it("is the tier, or the one below while on hold", () => {
    expect(effectiveTier(2, false)).toBe(2);
    expect(effectiveTier(2, true)).toBe(1);
    expect(effectiveTier(0, true)).toBe(0);
  });
});

describe("nextTier", () => {
  it("is the tier above, or null at Expert", () => {
    expect(nextTier(0)?.name).toBe("Skilled");
    expect(nextTier(2)?.name).toBe("Expert");
    expect(nextTier(3)).toBeNull();
  });
});

describe("evaluateTier: entry", () => {
  it("stays Starter below 250 XP", () => {
    const r = evaluateTier(starter, signals({ xp: 249, ...strong }), "answer");
    expect(r.state.tier).toBe(0);
    expect(r.tierUp).toBeNull();
  });

  it("enters Skilled at 250 XP with 80% of the last checks", () => {
    const r = evaluateTier(starter, signals({ xp: 250, checks: { passed: 8, total: 10 } }), "answer");
    expect(r.state.tier).toBe(1);
    expect(r.tierUp).toBe(1);
  });

  it("holds Skilled back below 80% once there are enough checks", () => {
    const r = evaluateTier(starter, signals({ xp: 300, checks: { passed: 7, total: 10 } }), "answer");
    expect(r.state.tier).toBe(0);
    expect(r.tierUp).toBeNull();
  });

  it("enters Trusted at 1,500 XP with 85% checks and 70% crowd", () => {
    const r = evaluateTier(
      at(1),
      signals({ xp: 1500, checks: { passed: 9, total: 10 }, crowd: { matched: 35, total: 50 } }),
      "answer",
    );
    expect(r.state.tier).toBe(2);
    expect(r.tierUp).toBe(2);
  });

  it("keeps Trusted closed under 70% crowd match", () => {
    const r = evaluateTier(
      at(1),
      signals({ xp: 1500, checks: { passed: 10, total: 10 }, crowd: { matched: 34, total: 50 } }),
      "answer",
    );
    expect(r.state.tier).toBe(1);
  });

  it("enters Expert at 4,000 XP, 90% checks, 75% crowd and 20 active days", () => {
    const r = evaluateTier(
      at(2),
      signals({ xp: 4000, checks: { passed: 9, total: 10 }, crowd: { matched: 38, total: 50 }, activeDays: 20 }),
      "answer",
    );
    expect(r.state.tier).toBe(3);
    expect(r.tierUp).toBe(3);
  });

  it("keeps Expert closed short of 20 active days", () => {
    const r = evaluateTier(at(2), signals({ xp: 5000, ...strong, activeDays: 19 }), "answer");
    expect(r.state.tier).toBe(2);
  });

  it("goes straight to the highest tier the labeler qualifies for", () => {
    const r = evaluateTier(starter, signals({ xp: 1600, ...strong }), "answer");
    expect(r.state.tier).toBe(2);
    expect(r.tierUp).toBe(2);
  });

  it("never lowers a tier, whatever the XP says", () => {
    const r = evaluateTier(at(2), signals({ xp: 0, ...strong }), "answer");
    expect(r.state.tier).toBe(2);
  });
});

describe("evaluateTier: when a tier opens", () => {
  it.each<TierEvent>(["crowd_match", "crowd_miss", "payout", "check_failed"])(
    "doesn't open one on %s: the labeler isn't looking",
    (event) => {
      const r = evaluateTier(starter, signals({ xp: 300, ...strong }), event);
      expect(r.state.tier).toBe(0);
      expect(r.tierUp).toBeNull();
    },
  );

  it("opens it on the next answer, with the XP those events added", () => {
    expect(evaluateTier(starter, signals({ xp: 300, ...strong }), "answer").tierUp).toBe(1);
  });

  it("opens it on a passed check", () => {
    expect(evaluateTier(starter, signals({ xp: 300, ...strong }), "check_passed").tierUp).toBe(1);
  });
});

describe("evaluateTier: short history (§3.2)", () => {
  it(`lets XP alone decide below ${TIER_RULES.minChecks} checks`, () => {
    const r = evaluateTier(starter, signals({ xp: 250, checks: { passed: 0, total: TIER_RULES.minChecks - 1 } }), "answer");
    expect(r.state.tier).toBe(1);
  });

  it(`applies the check floor from ${TIER_RULES.minChecks} checks`, () => {
    const r = evaluateTier(starter, signals({ xp: 250, checks: { passed: 3, total: TIER_RULES.minChecks } }), "answer");
    expect(r.state.tier).toBe(0);
  });

  it(`ignores the crowd floor below ${TIER_RULES.minCrowd} resolved answers`, () => {
    const r = evaluateTier(
      at(1),
      signals({ xp: 1500, checks: { passed: 10, total: 10 }, crowd: { matched: 0, total: TIER_RULES.minCrowd - 1 } }),
      "answer",
    );
    expect(r.state.tier).toBe(2);
  });

  it("can't put anyone on hold before the floor applies", () => {
    const r = evaluateTier(at(1), signals({ xp: 300, checks: { passed: 0, total: TIER_RULES.minChecks - 1 } }), "check_failed");
    expect(r.state.onHold).toBe(false);
  });
});

describe("evaluateTier: holds, never demotions", () => {
  it("puts Skilled on hold when a failed check leaves the last checks under 80%", () => {
    const r = evaluateTier(at(1), signals({ xp: 300, checks: { passed: 7, total: 10 } }), "check_failed");
    expect(r.state).toEqual({ tier: 1, onHold: true, holdChecksPassed: 0 });
    expect(r.heldNow).toBe(true);
  });

  it("keeps the tier when a failed check leaves the share at the floor", () => {
    const r = evaluateTier(at(1), signals({ xp: 300, checks: { passed: 8, total: 10 } }), "check_failed");
    expect(r.state.onHold).toBe(false);
  });

  it("puts Trusted on hold when a crowd miss leaves crowd match under 70%", () => {
    const r = evaluateTier(
      at(2),
      signals({ xp: 2000, checks: { passed: 10, total: 10 }, crowd: { matched: 34, total: 50 } }),
      "crowd_miss",
    );
    expect(r.state).toEqual({ tier: 2, onHold: true, holdChecksPassed: 0 });
  });

  it("holds only on the event that lowered a signal", () => {
    // Below the floor already, but this answer moved nothing: no new hold.
    const low = signals({ xp: 300, checks: { passed: 7, total: 10 } });
    for (const event of ["answer", "check_passed", "crowd_match"] as TierEvent[]) {
      expect(evaluateTier(at(1), low, event).state.onHold).toBe(false);
    }
  });

  it("never holds Starter", () => {
    const r = evaluateTier(starter, signals({ checks: { passed: 0, total: 10 } }), "check_failed");
    expect(r.state.onHold).toBe(false);
  });
});

describe("evaluateTier: reopening after the next 3 checks", () => {
  const held = at(1, { onHold: true });
  const low = signals({ xp: 300, checks: { passed: 6, total: 10 } });

  it("counts each passed check while on hold", () => {
    const r = evaluateTier(held, low, "check_passed");
    expect(r.state).toEqual({ tier: 1, onHold: true, holdChecksPassed: 1 });
    expect(r.reopened).toBe(false);
  });

  it(`reopens on the ${TIER_RULES.reopenAfterPasses}rd pass in a row`, () => {
    const r = evaluateTier({ ...held, holdChecksPassed: TIER_RULES.reopenAfterPasses - 1 }, low, "check_passed");
    expect(r.state).toEqual({ tier: 1, onHold: false, holdChecksPassed: 0 });
    expect(r.reopened).toBe(true);
  });

  it("starts the count again after a failed check", () => {
    const r = evaluateTier({ ...held, holdChecksPassed: 2 }, low, "check_failed");
    expect(r.state).toEqual({ tier: 1, onHold: true, holdChecksPassed: 0 });
  });

  it("leaves the count alone on answers and crowd results", () => {
    for (const event of ["answer", "crowd_match", "crowd_miss"] as TierEvent[]) {
      expect(evaluateTier({ ...held, holdChecksPassed: 2 }, low, event).state.holdChecksPassed).toBe(2);
    }
  });

  it("doesn't re-hold on the next answer after reopening, though the share is still low", () => {
    const reopened = evaluateTier({ ...held, holdChecksPassed: 2 }, low, "check_passed").state;
    expect(evaluateTier(reopened, low, "answer").state.onHold).toBe(false);
  });
});

describe("evaluateTier: XP on hold (§3.8)", () => {
  it("can't enter the next tier while on hold", () => {
    const r = evaluateTier(at(1, { onHold: true }), signals({ xp: 2000, ...strong }), "answer");
    expect(r.state.tier).toBe(1);
    expect(r.tierUp).toBeNull();
  });

  it("enters it on the check that reopens the tier", () => {
    const r = evaluateTier(at(1, { onHold: true, holdChecksPassed: 2 }), signals({ xp: 2000, ...strong }), "check_passed");
    expect(r.reopened).toBe(true);
    expect(r.state).toEqual({ tier: 2, onHold: false, holdChecksPassed: 0 });
    expect(r.tierUp).toBe(2);
  });
});
