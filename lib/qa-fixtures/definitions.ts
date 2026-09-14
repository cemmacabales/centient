// What each D1 fixture is, expressed as data rather than as a sequence of writes.
//
// The states are not invented here. They are read off `assertLedgerAgrees` in
// `lib/stellar/cosigner-ledger.ts`, which refuses in a fixed order: missing row,
// kind mismatch, **broadcast hash**, unsignable status, missing destination,
// destination mismatch, missing amount, amount mismatch. Hash is checked before
// status, and `SIGNABLE_STATUSES.submission` is `["pending", "failed"]`.
//
// That ordering is what separates the fixtures from each other. `qa-already-paid`
// is refused on its hash and never reaches the status check; `qa-non-validated`
// carries no hash and is refused on status. A fixture that conflated the two
// would let a co-signer regression pass QA unnoticed, because the refusal would
// still arrive — just for the wrong reason.
//
// `qa-failed-permanent` deliberately uses `failed`, which *is* a signable status.
// It is distinguished from `qa-non-validated` by a spent retry budget and a
// refund, not by signability. That is how the production code behaves —
// `reprocessPayoutWithNonceSafety` retries a submission whose broadcast never
// produced a hash — and a fixture that "cleaned this up" would be testing a rail
// that does not exist.
import type { RecipientShape } from "./manifest";

/** 1 USDC = 10^7 units. Mirrors `UNITS_PER_USDC` in `lib/stellar/config.ts`. */
export const UNITS_PER_USDC = 10_000_000n;

export type FixtureSlug =
  | "qa-validated"
  | "qa-non-validated"
  | "qa-already-paid"
  | "qa-cap-deferred"
  | "qa-failed-permanent"
  | "qa-needs-reconciliation";

/** What the campaign's accounting looks like for a given state. */
export type LedgerPosture =
  /** The reward was debited and never given back — the payout is still owed. */
  | "reserved"
  /** Debited, then refunded when the payout failed permanently. */
  | "refunded"
  /** Never debited: the payout never got far enough to reserve anything. */
  | "none";

export interface PayoutStateFixture {
  slug: FixtureSlug;
  shape: RecipientShape;
  /** `Submission.payoutStatus`. */
  payoutStatus: string;
  /** Whether the row carries a synthetic broadcast hash. */
  broadcast: boolean;
  retryCount: number;
  /** `Submission.payoutError`, when the state implies one. */
  payoutError: string | null;
  ledger: LedgerPosture;
  /** D1 cases whose preconditions this fixture satisfies. */
  cases: readonly string[];
  /** Why this row looks the way it does, for whoever reads the fixture later. */
  why: string;
}

/** Retry budget treated as spent, for the permanently-failed fixture. */
export const SPENT_RETRY_COUNT = 3;

export const PAYOUT_STATE_FIXTURES: readonly PayoutStateFixture[] = [
  {
    slug: "qa-validated",
    shape: "withTrustline",
    payoutStatus: "pending",
    broadcast: false,
    retryCount: 0,
    payoutError: null,
    ledger: "reserved",
    cases: ["D1-TC-008", "D1-TC-013", "D1-TC-017"],
    why: "The signable baseline: pending, no hash, a destination holding a USDC trustline. Every refusal fixture is this row with exactly one thing changed.",
  },
  {
    slug: "qa-non-validated",
    shape: "withTrustline",
    payoutStatus: "skipped",
    broadcast: false,
    retryCount: 0,
    payoutError: "quality gate not met — not payable",
    ledger: "none",
    cases: ["D1-TC-014"],
    why: "Terminal and unsignable, but carrying no hash, so the co-signer must refuse on its own status read rather than on a broadcast it can see.",
  },
  {
    slug: "qa-already-paid",
    shape: "withTrustline",
    payoutStatus: "sent",
    broadcast: true,
    retryCount: 0,
    payoutError: null,
    ledger: "reserved",
    cases: ["D1-TC-008", "D1-TC-014"],
    why: "Carries a broadcast hash. The co-signer checks that before status, so this proves the hash refusal specifically.",
  },
  {
    slug: "qa-cap-deferred",
    shape: "withTrustline",
    payoutStatus: "pending",
    broadcast: false,
    retryCount: 0,
    payoutError: "daily_cap_reached",
    ledger: "reserved",
    cases: ["D1-TC-017"],
    why: "Deferred by a cap refusal, not failed by it: still pending, retry budget untouched, campaign debit still reserved. A cap refusal that consumed a retry or released the reservation would be a defect.",
  },
  {
    slug: "qa-failed-permanent",
    shape: "withoutTrustline",
    payoutStatus: "failed",
    broadcast: false,
    retryCount: SPENT_RETRY_COUNT,
    payoutError: "op_no_trust — destination holds no USDC trustline",
    ledger: "refunded",
    cases: ["D1-TC-012"],
    why: "A permanent rail error: retry budget spent so nothing retries it, and the campaign refunded because no funds moved. Note `failed` is still a signable status — this is separated from qa-non-validated by budget and refund, not by signability.",
  },
  {
    slug: "qa-needs-reconciliation",
    shape: "withTrustline",
    payoutStatus: "needs_reconciliation",
    broadcast: true,
    retryCount: 0,
    payoutError: "accepted payment needs manual reconciliation",
    ledger: "reserved",
    cases: ["D1-TC-010", "D1-TC-011"],
    why: "Settled on-chain but could not be recorded: hash present, terminal, and pointedly NOT refunded, because the funds did leave. Needs no fault injection — a seeder writes the terminal row directly.",
  },
];

/**
 * How many payable references the concurrency fixtures seed.
 *
 * Twelve because #86 asks for twelve. Worth recording that the issue justifies it
 * by pointing at `payout-concurrency-db.test.ts`, which actually races `WORKERS =
 * 8`; the twelve belongs to `payout-submitter.test.ts`. D1-TC-009 itself only
 * requires "two or more", so twelve satisfies every reading and the discrepancy
 * changes nothing here.
 */
export const PAYABLE_REFERENCE_COUNT = 12;

/** Reward per payable reference: 0.5 USDC. */
export const PAYABLE_REWARD_UNITS = UNITS_PER_USDC / 2n;

/** Reward attached to each payout-state fixture: 1 USDC. */
export const FIXTURE_REWARD_UNITS = UNITS_PER_USDC;

export type CapPresetSlug = "qa-cap-below" | "qa-cap-at" | "qa-cap-above";

export interface CapPreset {
  slug: CapPresetSlug;
  amountUnits: bigint;
  expectation: string;
}

export interface CapPlan {
  /** The configured cap this plan was computed against. */
  capUnits: bigint;
  /** Settled volume the fixtures seed to consume the cap down to the headroom. */
  seededUsageUnits: bigint;
  /** What remains payable once that usage is in place. */
  headroomUnits: bigint;
  presets: readonly CapPreset[];
}

/** Remaining allowance the cap fixtures leave: 3 USDC. */
export const CAP_HEADROOM_UNITS = 3n * UNITS_PER_USDC;

/**
 * Place the rolling cap window at a known boundary.
 *
 * `getPayoutActivitySince` sums `PayoutJob` rows whose `broadcastAt` falls in the
 * trailing 24 hours and whose `txHash` is not null — with no constraint on the
 * hash's shape. Rolling usage is therefore seedable directly, which is what makes
 * D1-TC-017's "just below, exactly at, just above" reachable without moving real
 * funds.
 *
 * Computed from the configured cap at seed time rather than hard-coded, so the
 * fixtures stay correct when `DAILY_PAYOUT_CAP_UNITS` changes.
 */
export function planCapFixtures(
  capUnits: bigint,
  headroomUnits: bigint = CAP_HEADROOM_UNITS,
): CapPlan | null {
  // A cap of zero disables the limit entirely (`checkPayoutCap` returns early),
  // so there is no boundary to sit near and the fixtures would assert nothing.
  if (capUnits <= 0n) return null;

  // A cap smaller than the headroom cannot be consumed down to it. Rather than
  // silently shrinking the headroom — which would hand QA boundary amounts that
  // do not match the ones documented — refuse and let the caller say so.
  if (capUnits < headroomUnits) return null;

  const seededUsageUnits = capUnits - headroomUnits;

  return {
    capUnits,
    seededUsageUnits,
    headroomUnits,
    presets: [
      {
        slug: "qa-cap-below",
        amountUnits: headroomUnits - 1n,
        expectation: "allowed — one unit short of the remaining allowance",
      },
      {
        slug: "qa-cap-at",
        amountUnits: headroomUnits,
        expectation: "allowed — exactly exhausts the remaining allowance",
      },
      {
        slug: "qa-cap-above",
        amountUnits: headroomUnits + 1n,
        expectation: "refused — one unit beyond the remaining allowance",
      },
    ],
  };
}

/**
 * Total campaign balance the fixtures need reserved against them.
 *
 * Every fixture that debits the campaign needs the balance to cover it, or the
 * seed produces a campaign in deficit and QA sees balance errors that belong to
 * the fixture rather than to the rail.
 */
export function requiredCampaignBalanceUnits(
  fixtures: readonly PayoutStateFixture[] = PAYOUT_STATE_FIXTURES,
  payableCount: number = PAYABLE_REFERENCE_COUNT,
): bigint {
  const stateDebits = fixtures.filter((f) => f.ledger !== "none").length;
  return (
    BigInt(stateDebits) * FIXTURE_REWARD_UNITS +
    BigInt(payableCount) * PAYABLE_REWARD_UNITS
  );
}
