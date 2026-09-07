import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  type Asset,
  type Transaction,
} from "@stellar/stellar-sdk";
import { networkPassphrase, unitsToUsdcString } from "./config";

const DEFAULT_TIMEOUT_SECONDS = 180;

type SourceAccount = ConstructorParameters<typeof TransactionBuilder>[0];
type SignableTransaction = Transaction | FeeBumpTransaction;

function assertPublicKey(label: string, value: string): void {
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${label} must be a valid Stellar public key (G…), got "${value}"`);
  }
}

function parsePositiveStroops(label: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer stroop string, got "${value}"`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`${label} must be positive, got "${value}"`);
  }
  return parsed;
}

/** Build an unsigned, time-bounded USDC payment from integer 7-decimal units. */
export function buildUsdcPaymentTx({
  sourceAccount,
  destination,
  asset,
  amountUnits,
  fee = BASE_FEE,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
}: {
  sourceAccount: SourceAccount;
  destination: string;
  asset: Asset;
  amountUnits: bigint;
  fee?: string;
  timeoutSeconds?: number;
}): Transaction {
  assertPublicKey("destination", destination);
  if (amountUnits <= 0n) {
    throw new Error(`amountUnits must be positive, got ${amountUnits}`);
  }
  parsePositiveStroops("fee", fee);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`timeoutSeconds must be a positive integer, got ${timeoutSeconds}`);
  }

  return new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination,
        asset,
        amount: unitsToUsdcString(amountUnits),
      }),
    )
    .setTimeout(timeoutSeconds)
    .build();
}

/**
 * Produce every signature against the same immutable transaction hash, then
 * merge those independently produced signatures into the original envelope.
 */
export function addIndependentSignatures<T extends SignableTransaction>(
  transaction: T,
  signers: readonly Keypair[],
  minimumSigners = 2,
): T {
  if (!Number.isInteger(minimumSigners) || minimumSigners <= 0) {
    throw new Error(`minimumSigners must be a positive integer, got ${minimumSigners}`);
  }
  if (signers.length < minimumSigners) {
    throw new Error(
      `need at least ${minimumSigners} independent signer keys, got ${signers.length}`,
    );
  }

  const publicKeys = signers.map((signer) => signer.publicKey());
  if (new Set(publicKeys).size !== publicKeys.length) {
    throw new Error("independent signer keys must be distinct");
  }

  const signatures = signers.map((signer) => ({
    publicKey: signer.publicKey(),
    signature: transaction.getKeypairSignature(signer),
  }));
  for (const { publicKey, signature } of signatures) {
    transaction.addSignature(publicKey, signature);
  }
  return transaction;
}

/**
 * Return a valid fee-bump base fee (stroops per operation), never confusing it
 * with the envelope's total fee. The floor is the greater of the requested fee,
 * the inner transaction's per-operation fee, and Stellar's network minimum.
 */
export function minimumFeeBumpBaseFee(
  innerTransaction: Transaction,
  requestedBaseFee = BASE_FEE,
): string {
  const operationCount = innerTransaction.operations.length;
  if (operationCount === 0) {
    throw new Error("fee-bump inner transaction must contain at least one operation");
  }
  const innerFee = parsePositiveStroops("inner transaction fee", innerTransaction.fee);
  const requested = parsePositiveStroops("requested base fee", requestedBaseFee);
  const networkMinimum = BigInt(BASE_FEE);
  const innerPerOperation =
    (innerFee + BigInt(operationCount) - 1n) / BigInt(operationCount);

  return [networkMinimum, innerPerOperation, requested]
    .reduce((highest, candidate) => (candidate > highest ? candidate : highest))
    .toString();
}

/** Wrap an already dual-signed payment in an unsigned fee-bump envelope. */
export function buildMultisigFeeBump({
  feeSource,
  baseFee = BASE_FEE,
  innerTransaction,
  requiredSignerPublicKeys,
}: {
  feeSource: string;
  baseFee?: string;
  innerTransaction: Transaction;
  requiredSignerPublicKeys: readonly string[];
}): FeeBumpTransaction {
  assertPublicKey("fee source", feeSource);
  const independentHints = new Set(
    innerTransaction.signatures.map((signature) => signature.hint().toString("hex")),
  );
  if (independentHints.size < 2) {
    throw new Error("fee-bump inner transaction must carry at least 2 signatures");
  }
  if (
    requiredSignerPublicKeys.length < 2 ||
    new Set(requiredSignerPublicKeys).size !== requiredSignerPublicKeys.length
  ) {
    throw new Error("fee-bump requires at least 2 distinct required signer keys");
  }
  const innerHash = innerTransaction.hash();
  for (const publicKey of requiredSignerPublicKeys) {
    assertPublicKey("required signer", publicKey);
    const signer = Keypair.fromPublicKey(publicKey);
    const hasValidSignature = innerTransaction.signatures.some(
      (signature) =>
        signature.hint().equals(signer.signatureHint()) &&
        signer.verify(innerHash, signature.signature()),
    );
    if (!hasValidSignature) {
      throw new Error(`inner transaction is missing a valid required signer: ${publicKey}`);
    }
  }

  return TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    minimumFeeBumpBaseFee(innerTransaction, baseFee),
    innerTransaction,
    networkPassphrase(),
  );
}

export interface PayoutEvidence {
  amountUnits: bigint;
  recipientUsdcBeforeUnits: bigint;
  recipientUsdcAfterUnits: bigint;
  recipientXlmBeforeUnits: bigint;
  recipientXlmAfterUnits: bigint;
  expectedFeeAccount: string;
  feeAccount: string;
  innerSignatureCount: number;
  outerSignatureCount: number;
}

/** Assert the issue #6 on-chain proof before the runner prints success. */
export function verifyPayoutEvidence(evidence: PayoutEvidence): {
  recipientUsdcIncreaseUnits: bigint;
  recipientXlmSpentUnits: bigint;
} {
  const recipientUsdcIncreaseUnits =
    evidence.recipientUsdcAfterUnits - evidence.recipientUsdcBeforeUnits;
  const recipientXlmSpentUnits =
    evidence.recipientXlmBeforeUnits - evidence.recipientXlmAfterUnits;

  if (recipientUsdcIncreaseUnits !== evidence.amountUnits) {
    throw new Error(
      `recipient USDC increase ${recipientUsdcIncreaseUnits} does not equal payout ${evidence.amountUnits}`,
    );
  }
  if (
    evidence.recipientXlmBeforeUnits !== 0n ||
    evidence.recipientXlmAfterUnits !== 0n
  ) {
    throw new Error(
      `recipient must hold and spend zero XLM; before=${evidence.recipientXlmBeforeUnits}, after=${evidence.recipientXlmAfterUnits}`,
    );
  }
  if (evidence.feeAccount !== evidence.expectedFeeAccount) {
    throw new Error(
      `fee account ${evidence.feeAccount} does not match expected Centient account ${evidence.expectedFeeAccount}`,
    );
  }
  if (evidence.innerSignatureCount < 2) {
    throw new Error(
      `inner payment must carry at least 2 signatures, got ${evidence.innerSignatureCount}`,
    );
  }
  if (evidence.outerSignatureCount < 2) {
    throw new Error(
      `fee-bump envelope must carry at least 2 signatures, got ${evidence.outerSignatureCount}`,
    );
  }

  return { recipientUsdcIncreaseUnits, recipientXlmSpentUnits };
}
