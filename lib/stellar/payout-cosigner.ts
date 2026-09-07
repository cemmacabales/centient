// Resolution of the independent payout co-signer (issue #7).
//
// The payout account is a 2-of-3 multisig precisely so that no single process
// can move contributor funds. Issue #8 supplies the real second signer: an
// isolated policy service that re-derives the task ledger over authenticated
// transport and signs only what it independently agrees to pay.
//
// Until that service exists, this module provides the same contract in-process
// so the rail can be proven end to end on testnet — the two-signature settlement
// issue #7 must demonstrate. That local signer is a development affordance, not
// a deployment option: one process holding both keys is single-party control
// wearing a multisig's clothes. It is therefore refused on the public network and
// requires an explicit opt-in even on testnet, and the absence of any configured
// co-signer fails closed rather than degrading to a single signature.
import {
  Keypair,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { networkPassphrase, stellarNetwork } from "./config";
import { payoutAmountString } from "./payout-amount";
import type { PayoutCoSignRequest, PayoutCoSignature, PayoutCoSigner } from "./payout-envelope";

export type PayoutCoSignerEnvironment = Readonly<Record<string, string | undefined>>;

/** The payment operation an envelope actually settles, whatever wraps it. */
function innerPayment(transaction: Transaction | FeeBumpTransaction): {
  destination: string;
  amount: string;
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
  return operations[0] as unknown as { destination: string; amount: string };
}

/**
 * Re-derive what the envelope actually pays and refuse to sign unless it matches
 * the request. This is the check that makes the second signature meaningful: a
 * co-signer that signs whatever XDR it is handed adds a key, not a control.
 * Issue #8's service performs this same comparison against its own ledger copy.
 */
function assertEnvelopeMatchesRequest(
  request: PayoutCoSignRequest,
): Transaction | FeeBumpTransaction {
  const transaction = TransactionBuilder.fromXDR(request.xdr, networkPassphrase());
  const payment = innerPayment(transaction);

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

/**
 * An in-process co-signer holding the policy key directly. Signs only after
 * re-deriving the envelope's payment and matching it against the request, so it
 * exercises the same refusal paths the real service must.
 */
export function localPolicyCoSigner(policy: Keypair): PayoutCoSigner {
  return {
    async signPayout(request: PayoutCoSignRequest): Promise<PayoutCoSignature> {
      const transaction = assertEnvelopeMatchesRequest(request);
      return {
        publicKey: policy.publicKey(),
        signature: policy.sign(transaction.hash()).toString("base64"),
      };
    },
  };
}

/**
 * The co-signer this deployment may use. Throws rather than returning a
 * single-signature fallback: there is no configuration of this rail that pays out
 * on one signature.
 */
export function resolvePayoutCoSigner(
  env: PayoutCoSignerEnvironment = process.env,
): PayoutCoSigner {
  const secret = env.STELLAR_POLICY_SIGNER_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "no payout co-signer is configured — set STELLAR_POLICY_SIGNER_SECRET for the gated local signer, or wire the issue #8 policy service",
    );
  }

  const network = env.STELLAR_NETWORK?.trim().toLowerCase() ?? stellarNetwork();
  if (network === "public") {
    throw new Error(
      "the local payout co-signer is never permitted on the public network — one process holding both keys is not a 2-of-3",
    );
  }
  if (env.STELLAR_ALLOW_LOCAL_COSIGNER?.trim() !== "true") {
    throw new Error(
      "STELLAR_ALLOW_LOCAL_COSIGNER must be exactly \"true\" to co-sign payouts in-process",
    );
  }

  const policy = Keypair.fromSecret(secret);
  const expectedPublic = env.STELLAR_POLICY_SIGNER_PUBLIC?.trim();
  if (expectedPublic && expectedPublic !== policy.publicKey()) {
    throw new Error(
      `STELLAR_POLICY_SIGNER_SECRET does not match STELLAR_POLICY_SIGNER_PUBLIC (${expectedPublic})`,
    );
  }
  return localPolicyCoSigner(policy);
}
