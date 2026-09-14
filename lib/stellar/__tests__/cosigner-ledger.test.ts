import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assertLedgerAgrees, type LedgerPayout } from "../cosigner-ledger";
import type { PayoutCoSignRequest } from "../payout-envelope";

const destination = Keypair.random().publicKey();
const amountUnits = 25_000_000n;

function request(overrides: Partial<PayoutCoSignRequest> = {}): PayoutCoSignRequest {
  return {
    stage: "payment",
    xdr: "unused-by-the-ledger-check",
    destination,
    amountUnits,
    reference: { kind: "submission", id: "sub-1" },
    ...overrides,
  };
}

function submissionRow(overrides: Partial<LedgerPayout> = {}): LedgerPayout {
  return {
    kind: "submission",
    id: "sub-1",
    status: "pending",
    txHash: null,
    destination,
    amountUnits,
    ...overrides,
  };
}

function payoutJobRow(overrides: Partial<LedgerPayout> = {}): LedgerPayout {
  return {
    kind: "payout_job",
    id: "job-1",
    status: "queued",
    txHash: null,
    destination,
    amountUnits,
    ...overrides,
  };
}

describe("assertLedgerAgrees", () => {
  it("agrees with a pending submission whose destination and amount match", () => {
    expect(() => assertLedgerAgrees(submissionRow(), request())).not.toThrow();
  });

  it("agrees with a queued payout job whose destination and amount match", () => {
    const reference = { kind: "payout_job", id: "job-1" } as const;
    expect(() => assertLedgerAgrees(payoutJobRow(), request({ reference }))).not.toThrow();
  });

  it("refuses a payout the ledger has no row for", () => {
    expect(() => assertLedgerAgrees(null, request())).toThrow(/no ledger row/i);
  });

  it("refuses to pay a different destination than the ledger records", () => {
    // The request is the thing being verified, so the ledger's own destination is
    // the only one that counts. This is the check that stops a compromised payout
    // service from redirecting a legitimate reward to an attacker's account.
    const rogue = Keypair.random().publicKey();
    expect(() => assertLedgerAgrees(submissionRow(), request({ destination: rogue }))).toThrow(
      /destination/i,
    );
  });

  it("refuses to pay a different amount than the ledger records", () => {
    expect(() =>
      assertLedgerAgrees(submissionRow(), request({ amountUnits: 900_000_000n })),
    ).toThrow(/amount/i);
  });

  it("refuses a submission that already carries a broadcast hash", () => {
    // A hash means Horizon accepted the payment. Signing a second envelope for
    // the same row is the double-pay the whole rail is built to prevent, and the
    // co-signer refuses it independently of whatever state the payout service is in.
    expect(() => assertLedgerAgrees(submissionRow({ txHash: "abc123" }), request())).toThrow(
      /already/i,
    );
  });

  it("refuses a submission already in a terminal payout state", () => {
    for (const status of ["sent", "confirmed", "skipped", "needs_reconciliation"]) {
      expect(() => assertLedgerAgrees(submissionRow({ status }), request())).toThrow(
        /status/i,
      );
    }
  });

  it("agrees with a failed submission, which the retry path may legitimately re-sign", () => {
    // `reprocessPayoutWithNonceSafety` retries a failed submission that never got
    // a hash. Refusing it here would break a legitimate payout, not prevent one.
    expect(() => assertLedgerAgrees(submissionRow({ status: "failed" }), request())).not.toThrow();
  });

  it("refuses a payout job that is no longer claimable", () => {
    const reference = { kind: "payout_job", id: "job-1" } as const;
    for (const status of ["done", "failed"]) {
      expect(() =>
        assertLedgerAgrees(payoutJobRow({ status }), request({ reference })),
      ).toThrow(/status/i);
    }
  });

  it("refuses a row whose kind is not the one the request named", () => {
    // A submission id that resolves to a payout job (or the reverse) means the
    // reference and the row disagree about which ledger owes the money.
    expect(() => assertLedgerAgrees(payoutJobRow(), request())).toThrow(/kind/i);
  });

  it("refuses a row carrying no destination", () => {
    expect(() => assertLedgerAgrees(submissionRow({ destination: null }), request())).toThrow(
      /destination/i,
    );
  });

  it("refuses a row carrying no amount", () => {
    expect(() => assertLedgerAgrees(submissionRow({ amountUnits: null }), request())).toThrow(
      /amount/i,
    );
  });
});
