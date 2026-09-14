// The envelope checks every co-signer runs, wherever it is deployed.
//
// These live apart from both signers on purpose. The deployed policy service
// (issue #8) and the gated local signer used in development must agree exactly
// on what an envelope is allowed to say, because the local signer is how the
// refusal paths are exercised in tests and CI. Two copies of this logic would
// let the tested behaviour and the deployed behaviour drift silently — and the
// drift would only show up as a payout the real service signed and the tests
// said it would not.
import {
  TransactionBuilder,
  type Asset,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./config";
import { payoutAmountString } from "./payout-amount";
import type { PayoutCoSignRequest } from "./payout-envelope";

/** The payment operation an envelope actually settles, whatever wraps it. */
export function innerPayment(transaction: Transaction | FeeBumpTransaction): {
  destination: string;
  amount: string;
  asset: Asset;
} {
  const tx =
    "innerTransaction" in transaction
      ? (transaction as FeeBumpTransaction).innerTransaction
      : (transaction as Transaction);
  const operations = tx.operations;
  if (operations.length !== 1 || operations[0].type !== "payment") {
    throw new Error(
      `payout co-signer: envelope must carry exactly one payment operation, got [${operations
        .map((o) => o.type)
        .join(", ")}]`,
    );
  }
  return operations[0] as unknown as {
    destination: string;
    amount: string;
    asset: Asset;
  };
}

/**
 * Re-derive what the envelope actually pays and refuse unless it matches the
 * request. This is the check that makes the second signature meaningful: a
 * co-signer that signs whatever XDR it is handed adds a key, not a control.
 *
 * It establishes only that the envelope and the request agree. Whether the
 * *request* is a payout Centient owes at all is a separate question, answered
 * against the task ledger — see `assertRequestMatchesLedger`.
 */
export function assertEnvelopeMatchesRequest(
  request: PayoutCoSignRequest,
  expectedAsset: Asset,
): Transaction | FeeBumpTransaction {
  const transaction = TransactionBuilder.fromXDR(request.xdr, networkPassphrase());
  const payment = innerPayment(transaction);

  // The asset is checked against the co-signer's own configuration, never against
  // the request: a matching destination and numeric amount say nothing about
  // which asset is actually moving, and the request is the very thing being
  // independently verified.
  if (!payment.asset.equals(expectedAsset)) {
    throw new Error(
      `payout co-signer: envelope pays asset ${payment.asset.getCode()}:${payment.asset.getIssuer()}, not the configured payout asset ${expectedAsset.getCode()}:${expectedAsset.getIssuer()}`,
    );
  }
  if (payment.destination !== request.destination) {
    throw new Error(
      `payout co-signer: envelope destination ${payment.destination} does not match the requested destination ${request.destination}`,
    );
  }
  const expected = payoutAmountString(request.amountUnits);
  if (payment.amount !== expected) {
    throw new Error(
      `payout co-signer: envelope amount ${payment.amount} does not match the requested amount ${expected}`,
    );
  }
  return transaction;
}
