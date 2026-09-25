// #40 D4 — what a settled payout envelope actually paid.
//
// Horizon's `successful` says an envelope applied, not what it applied. Before a
// payout is recorded as confirmed, the envelope Horizon returns is decoded and
// held to the submission it settled: the same rules the co-signer applies before
// signing (`assertEnvelopeMatchesRequest`), plus the accounts the co-signer takes
// on trust from the builder. Read after the fact, they catch what signing could
// not, such as an envelope built by something other than the payout submitter.
import {
  TransactionBuilder,
  type Asset,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./config";
import { payoutAmountString } from "./payout-amount";

/** What a submission's payout must have been. */
export interface ExpectedPayout {
  /** `STELLAR_PLATFORM_ACCOUNT`: the payment's source and the fee bump's fee source. */
  payoutAccount: string;
  /** The submission's bound wallet. */
  destination: string;
  amountUnits: bigint;
  /** The configured USDC asset, code and issuer. */
  asset: Asset;
}

export type PayoutVerification = { ok: true } | { ok: false; mismatches: string[] };

interface PaymentOp {
  type: string;
  source?: string;
  destination?: string;
  amount?: string;
  asset?: Asset;
}

/**
 * Hold a settled envelope (Horizon's `envelope_xdr`) to the payout it should
 * have been. Every difference is reported, so a reviewer sees the whole of what
 * is wrong rather than the first thing the check tripped on.
 */
export function verifySettledPayout(envelopeXdr: string, expected: ExpectedPayout): PayoutVerification {
  let transaction: Transaction | FeeBumpTransaction;
  try {
    transaction = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase());
  } catch (err) {
    return { ok: false, mismatches: [`envelope does not decode: ${(err as Error).message}`] };
  }

  const mismatches: string[] = [];
  let inner: Transaction;
  if ("innerTransaction" in transaction) {
    inner = transaction.innerTransaction;
    // Centient pays every payout's fee from the payout account. A fee bump paid
    // by anyone else means something other than the payout submitter built it.
    if (transaction.feeSource !== expected.payoutAccount) {
      mismatches.push(`fee source ${transaction.feeSource} is not the payout account ${expected.payoutAccount}`);
    }
  } else {
    inner = transaction;
    mismatches.push("envelope is not a fee bump; every payout is submitted inside one");
  }

  if (inner.source !== expected.payoutAccount) {
    mismatches.push(`transaction source ${inner.source} is not the payout account ${expected.payoutAccount}`);
  }

  const operations = inner.operations as PaymentOp[];
  if (operations.length !== 1 || operations[0].type !== "payment") {
    mismatches.push(
      `envelope must carry exactly one payment operation, got [${operations.map((o) => o.type).join(", ")}]`,
    );
    return { ok: false, mismatches };
  }

  const payment = operations[0];
  if (payment.source !== undefined && payment.source !== expected.payoutAccount) {
    mismatches.push(`payment source ${payment.source} is not the payout account ${expected.payoutAccount}`);
  }
  if (payment.destination !== expected.destination) {
    mismatches.push(`destination ${payment.destination} is not the bound wallet ${expected.destination}`);
  }
  if (!payment.asset?.equals(expected.asset)) {
    const paid = payment.asset?.isNative() ? "XLM" : `${payment.asset?.getCode()}:${payment.asset?.getIssuer()}`;
    mismatches.push(`asset ${paid} is not ${expected.asset.getCode()}:${expected.asset.getIssuer()}`);
  }
  const amount = payoutAmountString(expected.amountUnits);
  if (payment.amount !== amount) {
    mismatches.push(`amount ${payment.amount} is not the payout amount ${amount}`);
  }

  return mismatches.length ? { ok: false, mismatches } : { ok: true };
}
