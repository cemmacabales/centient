// Stroops-precision accounting for the multisig payout rail (issue #7).
//
// Every payout amount travels as an integer `bigint` of 7-decimal units (stroops)
// from the database to the signed envelope. This module owns the two assertions
// that keep that path exact: the amount is a payable positive integer inside
// Stellar's int64 ceiling, and the destination is a plain `G…` account.
//
// Amounts are never parsed through `Number`. A payout of 922_337_203_685.4775807
// USDC is 9_223_372_036_854_775_807 stroops — four orders of magnitude past
// `Number.MAX_SAFE_INTEGER` — so a single float round-trip anywhere on this path
// would silently move money. String/BigInt arithmetic only, borrowed from
// `config.unitsToUsdcString`, which this module wraps rather than reimplements.
import { StrKey } from "@stellar/stellar-sdk";
import { unitsToUsdcString } from "./config";

/**
 * The largest amount Stellar can represent: `int64` max in stroops, i.e.
 * 922,337,203,685.4775807 of a 7-decimal asset. An operation above this is
 * rejected by the network, so we reject it before building an envelope.
 */
export const MAX_STELLAR_STROOPS = 9_223_372_036_854_775_807n;

/**
 * Assert `units` is a payable amount: strictly positive (a zero-value payment is
 * a no-op that still burns a sequence number and a fee) and within Stellar's
 * int64 ceiling. `label` names the field in the error so a rejection points at
 * the caller's own vocabulary rather than at this module.
 */
export function assertPayoutAmountUnits(units: bigint, label = "payout amount"): void {
  if (units <= 0n) {
    throw new Error(`${label} must be positive, got ${units} units`);
  }
  if (units > MAX_STELLAR_STROOPS) {
    throw new Error(
      `${label} ${units} units exceeds Stellar's maximum of ${MAX_STELLAR_STROOPS} stroops`,
    );
  }
}

/**
 * Assert `destination` is a plain Ed25519 `G…` account. Muxed `M…` addresses are
 * deliberately rejected: the payout rail keys idempotency and reconciliation off
 * the destination account, and two muxed addresses over one account would settle
 * to the same balance while reading as distinct destinations.
 */
export function assertPayoutDestination(
  destination: string,
  label = "payout destination",
): void {
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error(
      `${label} must be a valid Stellar public key (G…), got "${destination}"`,
    );
  }
}

/**
 * Render `units` as the fixed 7-decimal string the SDK's `Operation.payment`
 * takes, after asserting the amount is payable. Round-trips exactly through
 * `usdcToUnits`, which the unit tests pin for dust, ordinary, and ceiling values.
 */
export function payoutAmountString(units: bigint, label = "payout amount"): string {
  assertPayoutAmountUnits(units, label);
  return unitsToUsdcString(units);
}
