/**
 * P4a — withdrawal eligibility gates.
 *
 * Email+password identities are cheap to mass-create, so the anti-fraud
 * guardrails move to the withdrawal boundary (spec §4.4): a labeler can only
 * cash out once they have demonstrated quality history. This module is the pure
 * predicate — it knows nothing about HTTP or the database, so it is trivially
 * unit-testable and reused by both the endpoint and any future admin tooling.
 */

export type WithdrawalIneligibilityReason =
  | "min_submissions"
  | "gold_rate"
  | "account_age";

export interface WithdrawalThresholds {
  /** Minimum number of submitted answers. */
  minSubmissions: number;
  /** Minimum gold pass rate, in [0, 1]. */
  minGoldRate: number;
  /** Minimum account age, in milliseconds. */
  minAccountAgeMs: number;
}

/** The slice of the user record the gates inspect. */
export interface WithdrawalEligibilityInput {
  submissionCount: number;
  goldCorrect: number;
  goldAttempted: number;
  createdAt: Date;
}

export type WithdrawalEligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      reason: WithdrawalIneligibilityReason;
      /** The threshold that was not met, for surfacing a clear message in the UI. */
      required: number;
      /** The user's actual value for the failing gate. */
      actual: number;
    };

/**
 * Gold pass rate. A user with no gold attempts has not demonstrated any quality
 * and is treated as rate 0 — so any positive `minGoldRate` blocks them, while a
 * threshold of 0 (gate disabled) still lets them through.
 */
export function goldPassRate(goldCorrect: number, goldAttempted: number): number {
  return goldAttempted > 0 ? goldCorrect / goldAttempted : 0;
}

/**
 * Evaluates the three withdrawal gates in a stable order (submissions → gold
 * rate → account age) and returns the first that fails. A threshold of 0 (or a
 * non-positive age) disables that gate, so the default unconfigured state is
 * "no gating" rather than fail-closed.
 */
export function checkWithdrawalEligibility(
  user: WithdrawalEligibilityInput,
  thresholds: WithdrawalThresholds,
  now: Date = new Date(),
): WithdrawalEligibilityResult {
  if (thresholds.minSubmissions > 0 && user.submissionCount < thresholds.minSubmissions) {
    return {
      eligible: false,
      reason: "min_submissions",
      required: thresholds.minSubmissions,
      actual: user.submissionCount,
    };
  }

  if (thresholds.minGoldRate > 0) {
    const rate = goldPassRate(user.goldCorrect, user.goldAttempted);
    if (rate < thresholds.minGoldRate) {
      return {
        eligible: false,
        reason: "gold_rate",
        required: thresholds.minGoldRate,
        actual: rate,
      };
    }
  }

  if (thresholds.minAccountAgeMs > 0) {
    const ageMs = now.getTime() - user.createdAt.getTime();
    if (ageMs < thresholds.minAccountAgeMs) {
      return {
        eligible: false,
        reason: "account_age",
        required: thresholds.minAccountAgeMs,
        actual: ageMs,
      };
    }
  }

  return { eligible: true };
}
