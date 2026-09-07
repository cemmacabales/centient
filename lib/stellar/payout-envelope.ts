// Payout envelope construction and the independent co-signer seam (issue #7).
//
// The payout account is a 2-of-3 native multisig (issue #2/#5): no single key can
// move contributor funds. This module owns the network-free half of that flow —
// build the payment, add the platform's own signature, merge the independent
// co-signer's signature, and assert the result actually carries two distinct
// valid signers before anything is submitted.
//
// The co-signer seam is deliberately narrow. The co-signing service (issue #8)
// never returns a transaction; it returns only a detached signature plus the key
// that produced it. We merge that into *our* envelope and verify it against *our*
// transaction hash, so a compromised or buggy co-signer cannot substitute a
// different payout — the worst it can do is refuse to sign. See the substitution
// case in the unit tests.
import {
  Keypair,
  type Asset,
  type FeeBumpTransaction,
  type Transaction,
  type TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildUsdcPaymentTx } from "./multisig-payout";
import { assertPayoutAmountUnits, assertPayoutDestination } from "./payout-amount";

type SourceAccount = ConstructorParameters<typeof TransactionBuilder>[0];
/**
 * Either envelope in the payout flow. Both the inner payment and the fee-bump
 * that wraps it are sourced by the multisig hot account, so both need the same
 * two independent signatures before submission.
 */
type SignableTransaction = Transaction | FeeBumpTransaction;

/** Which envelope the co-signer is being asked to sign for one payout. */
export type PayoutSigningStage = "payment" | "fee_bump";

/**
 * The ledger row a payout settles. Discriminated rather than a bare id because
 * the two payout paths draw from different tables — a per-submission reward and
 * a lump-sum payout job — and the co-signer (issue #8) re-derives the amount from
 * whichever row this names. A single opaque id would leave it guessing which.
 */
export type PayoutReference =
  | { kind: "submission"; id: string }
  | { kind: "payout_job"; id: string };

/**
 * One request to the independent co-signer. `xdr` is the envelope as we built and
 * platform-signed it; the payout fields are the claim the co-signer re-derives
 * from its own copy of the task ledger (issue #8) before agreeing to sign.
 */
export interface PayoutCoSignRequest {
  stage: PayoutSigningStage;
  xdr: string;
  destination: string;
  amountUnits: bigint;
  reference: PayoutReference;
}

/** A detached signature and the key that produced it — never a transaction. */
export interface PayoutCoSignature {
  publicKey: string;
  /** Base64 Ed25519 signature over the envelope's network-scoped hash. */
  signature: string;
}

/**
 * The independent second signer. Issue #8 implements this over authenticated
 * transport against an isolated policy service; issue #7 depends only on this
 * shape so the two can land in either order.
 */
export interface PayoutCoSigner {
  signPayout(request: PayoutCoSignRequest): Promise<PayoutCoSignature>;
}

/**
 * Build the unsigned USDC payment for one payout from the multisig hot account.
 * Amount and destination are asserted here so a bad payout is rejected before an
 * envelope (and therefore a sequence number) is ever spent on it.
 */
export function buildPayoutPayment({
  sourceAccount,
  destination,
  asset,
  amountUnits,
  fee,
  timeoutSeconds,
}: {
  sourceAccount: SourceAccount;
  destination: string;
  asset: Asset;
  amountUnits: bigint;
  fee?: string;
  timeoutSeconds?: number;
}): Transaction {
  assertPayoutDestination(destination);
  assertPayoutAmountUnits(amountUnits);
  return buildUsdcPaymentTx({
    sourceAccount,
    destination,
    asset,
    amountUnits,
    ...(fee === undefined ? {} : { fee }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  });
}

/** Add the platform's own signature — signature #1 of the required two. */
export function signAsPlatform<T extends SignableTransaction>(
  transaction: T,
  platform: Keypair,
): T {
  transaction.sign(platform);
  return transaction;
}

/**
 * Merge the independent co-signer's detached signature into `transaction`.
 *
 * Both checks run before the envelope is touched, so a rejected co-signature
 * leaves the transaction exactly as it was: the signature must come from the
 * configured co-signer, and it must verify against this envelope's own hash. The
 * second check is what makes substitution impossible — a signature the co-signer
 * produced over any other payout simply does not verify here.
 */
export function applyCoSignature<T extends SignableTransaction>(
  transaction: T,
  coSignature: PayoutCoSignature,
  expectedCoSignerPublicKey: string,
): T {
  if (coSignature.publicKey !== expectedCoSignerPublicKey) {
    throw new Error(
      `co-signature is not the configured co-signer: expected ${expectedCoSignerPublicKey}, got ${coSignature.publicKey}`,
    );
  }
  const signer = Keypair.fromPublicKey(expectedCoSignerPublicKey);
  const signature = Buffer.from(coSignature.signature, "base64");
  if (!signer.verify(transaction.hash(), signature)) {
    throw new Error(
      `co-signature from ${coSignature.publicKey} does not verify against this payout envelope`,
    );
  }
  transaction.addSignature(coSignature.publicKey, coSignature.signature);
  return transaction;
}

/**
 * Assert `transaction` carries a cryptographically valid signature from every key
 * in `requiredSignerPublicKeys`. This is the invariant that no payout leaves the
 * process on one signature (proved end to end in issue #12).
 *
 * Signature *count* is never the test. A decorated signature's hint is only four
 * bytes, so distinct signers can legitimately collide, and one key signing twice
 * would otherwise read as two parties. Identity is established by verifying each
 * required key against the envelope hash.
 */
export function assertPayoutFullySigned(
  transaction: SignableTransaction,
  requiredSignerPublicKeys: readonly string[],
): void {
  if (
    requiredSignerPublicKeys.length < 2 ||
    new Set(requiredSignerPublicKeys).size !== requiredSignerPublicKeys.length
  ) {
    throw new Error("a payout requires at least 2 distinct required signer keys");
  }
  const hash = transaction.hash();
  for (const publicKey of requiredSignerPublicKeys) {
    const signer = Keypair.fromPublicKey(publicKey);
    const hasValidSignature = transaction.signatures.some(
      (signature) =>
        signature.hint().equals(signer.signatureHint()) &&
        signer.verify(hash, signature.signature()),
    );
    if (!hasValidSignature) {
      throw new Error(`payout envelope is missing a valid required signer: ${publicKey}`);
    }
  }
}
