import type { WithdrawalThresholds } from "@/lib/withdrawal-eligibility";

// Chain config (network, Horizon, explorer, USDC asset) lives in
// lib/stellar/config.ts.

// Public — also used by the client UI. Stellar's native asset is XLM with 7
// decimals (1 XLM = 10^7 units); see lib/stellar/config.ts for the conversion
// boundary. ST-2b (#294) re-valued these from the legacy 18-decimal token layer.
export const REWARD_AMOUNT = process.env.NEXT_PUBLIC_REWARD_AMOUNT ?? "0.05";
export const REWARD_TOKEN_SYMBOL = process.env.NEXT_PUBLIC_REWARD_TOKEN_SYMBOL ?? "USDC";
export const REWARD_TOKEN_DECIMALS = Number(process.env.NEXT_PUBLIC_REWARD_TOKEN_DECIMALS ?? "7");
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export function parseGoldRatio(raw: string | undefined): number {
  const value = Number(raw?.trim() || "0.1");
  if (value < 0 || value > 1 || Number.isNaN(value)) {
    throw new Error(`GOLD_TASK_RATIO must be between 0 and 1, got "${raw}"`);
  }
  return value;
}

export const GOLD_TASK_RATIO = parseGoldRatio(process.env.GOLD_TASK_RATIO);

// Fraud detection: maximum distinct accounts a single wallet can receive
// withdrawals from before being flagged/blocked.
export const MAX_SHARED_WALLET_ACCOUNTS = Number(process.env.MAX_SHARED_WALLET_ACCOUNTS ?? "3");

// P4a — withdrawal eligibility gates. These anti-fraud thresholds (spec §4.4)
// gate cash-out behind quality history so cheap mass-created accounts can't
// instantly withdraw. These fail *open*: an unset (or
// 0) value disables that gate, so gating is opt-in per environment. Recommended
// production values: WITHDRAWAL_MIN_SUBMISSIONS=50, WITHDRAWAL_MIN_GOLD_RATE=0.7,
// WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS=24.

function parseNonNegativeInt(raw: string | undefined, name: string): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

export function getWithdrawalMinSubmissions(): number {
  return parseNonNegativeInt(
    process.env.WITHDRAWAL_MIN_SUBMISSIONS,
    "WITHDRAWAL_MIN_SUBMISSIONS",
  );
}

export function getWithdrawalMinGoldRate(): number {
  const raw = process.env.WITHDRAWAL_MIN_GOLD_RATE;
  if (!raw) return 0;
  const value = Number(raw);
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(
      `WITHDRAWAL_MIN_GOLD_RATE must be between 0 and 1, got "${raw}"`,
    );
  }
  return value;
}

export function getWithdrawalMinAccountAgeMs(): number {
  const hours = parseNonNegativeInt(
    process.env.WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS,
    "WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS",
  );
  return hours * 60 * 60 * 1000;
}

export function getWithdrawalThresholds(): WithdrawalThresholds {
  return {
    minSubmissions: getWithdrawalMinSubmissions(),
    minGoldRate: getWithdrawalMinGoldRate(),
    minAccountAgeMs: getWithdrawalMinAccountAgeMs(),
  };
}

// Submission payout statuses that represent an *accepted & rewarded* answer:
// an instant payout still in flight ("pending", #37), a per-question on-chain
// payout ("sent"/"confirmed"), and the legacy accumulate-then-withdraw path
// ("accrued" — credited to the user's off-chain balance until #39). Use this
// wherever answers are counted toward a task's response target; agreement
// scoring and task resolution use SETTLED_STATUSES below. "pending" is here because an accepted answer is
// written `pending` and paid out of band: leaving it out would let a task be
// over-answered, and over-paid, while its payouts are in flight. NOTE: this is
// deliberately NOT the same set used for on-chain *spend* accounting
// (lib/payout-cap.ts), which must only count funds actually moved on-chain.
export const REWARDED_STATUSES = ["pending", "sent", "confirmed", "accrued"] as const;

// The subset of REWARDED_STATUSES whose payout has settled: paid on-chain, or
// credited under the legacy balance. Use this for anything irreversible that an
// answer feeds — agreement scoring and resolving a task — because a `pending`
// payout can still fail, be refunded, and drop out of REWARDED_STATUSES, and a
// resolved task is never recomputed (#37). `pending` reserves room under the
// response target; only a settled answer decides the result.
export const SETTLED_STATUSES = ["sent", "confirmed", "accrued"] as const;
