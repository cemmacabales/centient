// Co-signer answers that mean "not now" rather than "no" (#47).
//
// A refusal on the merits — the ledger disagrees, the row is already paid, an
// envelope is still open — ends that payout attempt, and the worker spends a
// retry on it. Two answers are different: the co-signer being unreachable, and
// the co-signer's own daily cap being spent. Neither says anything about whether
// the payout is owed, and both clear on their own. Treated as ordinary errors,
// three immediate worker passes failed the payout and refunded it (#46), so a
// co-signer outage of a few seconds cost a contributor their reward.
//
// These classes let every payer defer instead. Kept free of imports: the
// co-signer service reads the refusal code from here, and it must not pull the
// payout rail in with it.

/** The `code` the co-signer puts on a refusal because its own daily cap is spent. */
export const COSIGNER_CAP_REFUSAL_CODE = "daily_cap_reached";

/**
 * The co-signer could not be asked: the request failed in transit, timed out,
 * or the service answered 5xx. Nothing was signed, so nothing can have been
 * submitted.
 */
export class CoSignerUnavailableError extends Error {
  readonly code = "cosigner_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "CoSignerUnavailableError";
  }
}

/**
 * The co-signer refused because its own daily cap is spent. The payout service's
 * cap may still have room: the two are configured separately and measured over
 * different windows, which is the point of having two.
 */
export class CoSignerCapError extends Error {
  readonly code = "cosigner_cap_reached";

  constructor(message: string) {
    super(message);
    this.name = "CoSignerCapError";
  }
}
