// Tiers (#202, ADR-0011). Pure: no clock, no database, no server imports, so
// client components can read the ramp too. A tier gates which tasks are open
// and never pays: money moves only through the tasks it opens (ADR-0010).
//
// Every threshold lives here, so a retune after the first week's data is a
// one-line change (board 02).

export interface TierDef {
  id: number;
  name: string;
  /** XP to enter. */
  xp: number;
  /** Highest task difficulty served at this tier. */
  maxDifficulty: number;
  /** Share of the last checks passed, to enter and to keep the tier open. */
  checkFloor: number | null;
  /** Share of the last resolved answers that matched the crowd. */
  crowdFloor: number | null;
  /** Manila days with at least one counted answer, to enter. */
  activeDays: number | null;
}

export const TIERS: readonly TierDef[] = [
  { id: 0, name: "Starter", xp: 0, maxDifficulty: 3, checkFloor: null, crowdFloor: null, activeDays: null },
  { id: 1, name: "Skilled", xp: 250, maxDifficulty: 5, checkFloor: 0.8, crowdFloor: null, activeDays: null },
  { id: 2, name: "Trusted", xp: 1500, maxDifficulty: 7, checkFloor: 0.85, crowdFloor: 0.7, activeDays: null },
  { id: 3, name: "Expert", xp: 4000, maxDifficulty: 9, checkFloor: 0.9, crowdFloor: 0.75, activeDays: 20 },
];

export const TIER_RULES = {
  /** The check floor reads the last this-many quality checks… */
  checkWindow: 10,
  /** …and applies only once there are at least this many (§3.2). */
  minChecks: 5,
  crowdWindow: 50,
  minCrowd: 20,
  /** Passed checks in a row that reopen a tier on hold. */
  reopenAfterPasses: 3,
} as const;

export interface TierState {
  tier: number;
  onHold: boolean;
  /** Passes in a row since the hold began. */
  holdChecksPassed: number;
}

export interface TierSignals {
  xp: number;
  /** Over the last `checkWindow` quality checks, retest excluded. */
  checks: { passed: number; total: number };
  /** Over the last `crowdWindow` answers on resolved, non-tie tasks. */
  crowd: { matched: number; total: number };
  activeDays: number;
}

/**
 * What was just recorded. Only an event that lowers a signal can start a hold,
 * and only one the labeler is looking at can open a tier, so the tier-up
 * screen always shows: crowd results and payouts settle in the worker.
 */
export type TierEvent = "answer" | "check_passed" | "check_failed" | "crowd_match" | "crowd_miss" | "payout";

const OPENS_TIERS: ReadonlySet<TierEvent> = new Set(["answer", "check_passed"]);

export interface TierResult {
  state: TierState;
  /** The tier just entered, if any. */
  tierUp: number | null;
  heldNow: boolean;
  reopened: boolean;
}

/** The tier whose tasks are open: the one below while a hold lasts. */
export function effectiveTier(tier: number, onHold: boolean): number {
  return onHold ? Math.max(0, tier - 1) : tier;
}

/** The highest difficulty served. A task with no difficulty is open to everyone. */
export function maxDifficulty(tier: number, onHold: boolean): number {
  return TIERS[effectiveTier(tier, onHold)].maxDifficulty;
}

/** The lowest tier whose band holds this difficulty; a task with none is open to all. */
export function tierOfDifficulty(difficulty: number | null): number {
  if (difficulty === null) return 0;
  const def = TIERS.find((t) => difficulty <= t.maxDifficulty);
  return def ? def.id : TIERS.length - 1;
}

/**
 * What a quality check shows instead of its own (empty) difficulty: a stand-in
 * from the band the labeler is served, stable per seed, so its XP pill and tier
 * chip look like any other task's. Display only: never pay, serving or XP.
 */
export function standInDifficulty(seed: string, maxDifficulty: number): number {
  let h = 0;
  for (const c of seed) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return 1 + (h % maxDifficulty);
}

/** A stored tier's name; null for a row from before tiers (#202). */
export function labelerTierName(tier: number | null): string | null {
  return tier === null ? null : (TIERS[tier]?.name ?? null);
}

export function nextTier(tier: number): TierDef | null {
  return TIERS[tier + 1] ?? null;
}

/** A floor applies only once there is enough history to judge it. */
function floorMet(hits: number, total: number, min: number, floor: number | null): boolean {
  if (floor === null || total < min) return true;
  return hits / total >= floor;
}

function checksMet(def: TierDef, s: TierSignals): boolean {
  return floorMet(s.checks.passed, s.checks.total, TIER_RULES.minChecks, def.checkFloor);
}

function crowdMet(def: TierDef, s: TierSignals): boolean {
  return floorMet(s.crowd.matched, s.crowd.total, TIER_RULES.minCrowd, def.crowdFloor);
}

function qualifies(def: TierDef, s: TierSignals): boolean {
  return s.xp >= def.xp && checksMet(def, s) && crowdMet(def, s) && (def.activeDays === null || s.activeDays >= def.activeDays);
}

/**
 * The tier after `event`. A tier is never taken away: falling below a floor
 * puts it on hold, and the next `reopenAfterPasses` checks in a row reopen it.
 * A hold starts only on the event that lowered the signal, so a tier that has
 * just reopened isn't held again by the very next answer.
 */
export function evaluateTier(current: TierState, signals: TierSignals, event: TierEvent): TierResult {
  let { tier, onHold, holdChecksPassed } = current;
  let heldNow = false;
  let reopened = false;

  if (onHold) {
    if (event === "check_passed") holdChecksPassed += 1;
    if (event === "check_failed") holdChecksPassed = 0;
    if (holdChecksPassed >= TIER_RULES.reopenAfterPasses) {
      onHold = false;
      holdChecksPassed = 0;
      reopened = true;
    }
  } else if (tier > 0) {
    const def = TIERS[tier];
    const dropped =
      (event === "check_failed" && !checksMet(def, signals)) || (event === "crowd_miss" && !crowdMet(def, signals));
    if (dropped) {
      onHold = true;
      holdChecksPassed = 0;
      heldNow = true;
    }
  }

  let tierUp: number | null = null;
  if (!onHold && OPENS_TIERS.has(event)) {
    for (let t = TIERS.length - 1; t > tier; t--) {
      if (qualifies(TIERS[t], signals)) {
        tier = t;
        tierUp = t;
        break;
      }
    }
  }

  return { state: { tier, onHold, holdChecksPassed }, tierUp, heldNow, reopened };
}
