import {
  BASE_FEE,
  type Asset,
  FeeBumpTransaction,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { explorerUrl, networkPassphrase, unitsToUsdcString } from "./config";

type SourceAccount = ConstructorParameters<typeof TransactionBuilder>[0];

export interface ReserveRefillPolicy {
  coldAccount: string;
  hotAccount: string;
  signerPublicKeys: readonly [string, string, string];
  triggerUnits: bigint;
  targetUnits: bigint;
  minRetainUnits: bigint;
}

export type ReserveRefillEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ReserveRefillPlan =
  | {
      status: "healthy";
      hotBalanceUnits: bigint;
      coldBalanceUnits: bigint;
    }
  | {
      status: "refill_required";
      amountUnits: bigint;
      hotBalanceUnits: bigint;
      coldBalanceUnits: bigint;
      coldAfterUnits: bigint;
    }
  | {
      status: "insufficient_reserve";
      requiredUnits: bigint;
      availableUnits: bigint;
      hotBalanceUnits: bigint;
      coldBalanceUnits: bigint;
    };

export interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

function requireEnv(env: ReserveRefillEnvironment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requirePublicKey(env: ReserveRefillEnvironment, name: string): string {
  const value = requireEnv(env, name).trim();
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${name} must be a valid Stellar public key (G…)`);
  }
  return value;
}

function requireUnits(env: ReserveRefillEnvironment, name: string): bigint {
  const value = requireEnv(env, name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer unit string`);
  }
  return BigInt(value);
}

export function parseReserveRefillPolicy(
  env: ReserveRefillEnvironment = process.env,
): ReserveRefillPolicy {
  const coldAccount = requirePublicKey(env, "STELLAR_COLD_RESERVE_ACCOUNT");
  const opsPublic = requirePublicKey(env, "STELLAR_COLD_OPS_SIGNER_PUBLIC");
  const policyPublic = requirePublicKey(
    env,
    "STELLAR_COLD_POLICY_SIGNER_PUBLIC",
  );

  const platformSecret = requireEnv(env, "STELLAR_PLATFORM_SECRET").trim();
  let hotAccount: string;
  try {
    hotAccount = Keypair.fromSecret(platformSecret).publicKey();
  } catch {
    throw new Error(
      "STELLAR_PLATFORM_SECRET must be a valid Stellar secret seed (S…)",
    );
  }

  const identities = [coldAccount, hotAccount, opsPublic, policyPublic];
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      "cold reserve, hot wallet, ops signer, and policy signer must be distinct",
    );
  }

  const triggerUnits = requireUnits(env, "STELLAR_HOT_FLOAT_TRIGGER_UNITS");
  const targetUnits = requireUnits(env, "STELLAR_HOT_FLOAT_TARGET_UNITS");
  const minRetainUnits = requireUnits(env, "STELLAR_COLD_MIN_RETAIN_UNITS");

  if (targetUnits <= 0n) {
    throw new Error("STELLAR_HOT_FLOAT_TARGET_UNITS target must be positive");
  }
  if (targetUnits <= triggerUnits) {
    throw new Error(
      "STELLAR_HOT_FLOAT_TARGET_UNITS must be greater than STELLAR_HOT_FLOAT_TRIGGER_UNITS",
    );
  }

  return {
    coldAccount,
    hotAccount,
    signerPublicKeys: [coldAccount, opsPublic, policyPublic],
    triggerUnits,
    targetUnits,
    minRetainUnits,
  };
}

/** Convert a non-negative Stellar decimal with at most seven places to units. */
export function stellarAmountToUnits(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value);
  if (!match) {
    throw new Error(
      `invalid Stellar amount "${value}"; expected a non-negative decimal with at most 7 places`,
    );
  }
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(7, "0"));
  return whole * 10_000_000n + fractional;
}

/** Extract one issued-asset trustline exactly; a missing trustline is zero. */
export function extractAssetBalanceUnits(
  balances: readonly HorizonBalanceLine[],
  asset: Asset,
): bigint {
  const line = balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_code === asset.getCode() &&
      balance.asset_issuer === asset.getIssuer(),
  );
  return line ? stellarAmountToUnits(line.balance) : 0n;
}

/** Decide whether the hot wallet needs one exact refill to its target. */
export function planReserveRefill(
  policy: ReserveRefillPolicy,
  hotBalanceUnits: bigint,
  coldBalanceUnits: bigint,
): ReserveRefillPlan {
  if (hotBalanceUnits > policy.triggerUnits) {
    return { status: "healthy", hotBalanceUnits, coldBalanceUnits };
  }

  const amountUnits = policy.targetUnits - hotBalanceUnits;
  const coldAfterUnits = coldBalanceUnits - amountUnits;
  if (coldAfterUnits < policy.minRetainUnits) {
    const availableUnits =
      coldBalanceUnits > policy.minRetainUnits
        ? coldBalanceUnits - policy.minRetainUnits
        : 0n;
    return {
      status: "insufficient_reserve",
      requiredUnits: amountUnits,
      availableUnits,
      hotBalanceUnits,
      coldBalanceUnits,
    };
  }

  return {
    status: "refill_required",
    amountUnits,
    hotBalanceUnits,
    coldBalanceUnits,
    coldAfterUnits,
  };
}

/** Build the only transaction shape a cold reserve refill may use. */
export function buildReserveRefillTransaction({
  sourceAccount,
  policy,
  asset,
  amountUnits,
  fee = BASE_FEE,
  timeoutSeconds = 180,
}: {
  sourceAccount: SourceAccount;
  policy: ReserveRefillPolicy;
  asset: Asset;
  amountUnits: bigint;
  fee?: string;
  timeoutSeconds?: number;
}): Transaction {
  if (amountUnits <= 0n || amountUnits > policy.targetUnits) {
    throw new Error(
      `reserve refill amount must be positive and no greater than target; got ${amountUnits}`,
    );
  }
  if (!/^\d+$/.test(fee) || BigInt(fee) <= 0n) {
    throw new Error(`reserve refill fee must be a positive stroop string; got "${fee}"`);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(
      `reserve refill timeoutSeconds must be a positive integer; got ${timeoutSeconds}`,
    );
  }

  return new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination: policy.hotAccount,
        asset,
        amount: unitsToUsdcString(amountUnits),
      }),
    )
    .setTimeout(timeoutSeconds)
    .build();
}

export const MAX_RESERVE_REFILL_FEE_STROOPS = 10_000n;

/** Enforce the exact refill envelope before either signing or submission. */
export function validateReserveRefillTransaction({
  transaction,
  policy,
  asset,
  expectedAmountUnits,
  nowSeconds,
  requireSignatures,
}: {
  transaction: Transaction | FeeBumpTransaction;
  policy: ReserveRefillPolicy;
  asset: Asset;
  expectedAmountUnits: bigint;
  nowSeconds: number;
  requireSignatures: boolean;
}): void {
  if (transaction instanceof FeeBumpTransaction) {
    throw new Error("reserve refill must not use a fee-bump envelope");
  }
  if (transaction.source !== policy.coldAccount) {
    throw new Error("reserve refill source does not match the cold reserve");
  }
  if (transaction.operations.length !== 1) {
    throw new Error("reserve refill must contain exactly one operation");
  }

  const operation = transaction.operations[0];
  if (operation.type !== "payment") {
    throw new Error("reserve refill operation must be a payment");
  }
  if (operation.source !== undefined) {
    throw new Error("reserve refill payment must not override its operation source");
  }
  if (operation.destination !== policy.hotAccount) {
    throw new Error("reserve refill destination does not match the hot wallet");
  }
  if (
    operation.asset.getCode() !== asset.getCode() ||
    operation.asset.getIssuer() !== asset.getIssuer()
  ) {
    throw new Error("reserve refill asset does not match configured USDC");
  }
  if (operation.amount !== unitsToUsdcString(expectedAmountUnits)) {
    throw new Error("reserve refill amount does not match the current exact plan");
  }

  if (!/^\d+$/.test(transaction.fee)) {
    throw new Error("reserve refill fee is not an integer stroop string");
  }
  const fee = BigInt(transaction.fee);
  if (fee <= 0n || fee > MAX_RESERVE_REFILL_FEE_STROOPS) {
    throw new Error(
      `reserve refill fee must be between 1 and ${MAX_RESERVE_REFILL_FEE_STROOPS} stroops`,
    );
  }

  const maxTime = Number(transaction.timeBounds?.maxTime ?? 0);
  if (!Number.isSafeInteger(maxTime) || maxTime <= 0) {
    throw new Error("reserve refill transaction must have a finite maximum time");
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("reserve refill validation time must be a non-negative integer");
  }
  if (maxTime < nowSeconds) {
    throw new Error("reserve refill transaction is expired");
  }

  const transactionHash = transaction.hash();
  const validSignerKeys = new Set<string>();
  for (const signature of transaction.signatures) {
    const owner = policy.signerPublicKeys.find((publicKey) => {
      const signer = Keypair.fromPublicKey(publicKey);
      return (
        signature.hint().equals(signer.signatureHint()) &&
        signer.verify(transactionHash, signature.signature())
      );
    });
    if (!owner) {
      throw new Error("reserve refill contains an unconfigured signature");
    }
    if (validSignerKeys.has(owner)) {
      throw new Error(`reserve refill contains a duplicate signature from ${owner}`);
    }
    validSignerKeys.add(owner);
  }

  if (requireSignatures && validSignerKeys.size < 2) {
    throw new Error(
      `reserve refill requires two distinct configured signatures; got ${validSignerKeys.size}`,
    );
  }
}

/** Add one configured custodian signature without accepting the same key twice. */
export function addReserveRefillSignature(
  transaction: Transaction,
  signer: Keypair,
  policy: ReserveRefillPolicy,
): Transaction {
  const publicKey = signer.publicKey();
  if (!policy.signerPublicKeys.includes(publicKey)) {
    throw new Error(`reserve refill signer ${publicKey} is not configured`);
  }

  const transactionHash = transaction.hash();
  const alreadySigned = transaction.signatures.some(
    (signature) =>
      signature.hint().equals(signer.signatureHint()) &&
      signer.verify(transactionHash, signature.signature()),
  );
  if (alreadySigned) {
    throw new Error(`reserve refill is already signed by ${publicKey}`);
  }

  transaction.sign(signer);
  return transaction;
}

/** Validate and submit one signed refill envelope without automatic retries. */
export async function submitReserveRefill({
  signedXdr,
  policy,
  asset,
  expectedAmountUnits,
  nowSeconds,
  submit,
  log,
}: {
  signedXdr: string;
  policy: ReserveRefillPolicy;
  asset: Asset;
  expectedAmountUnits: bigint;
  nowSeconds: number;
  submit: (transaction: Transaction) => Promise<{ hash: string }>;
  log: (message: string) => void;
}): Promise<{ hash: string }> {
  const decoded = TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
  validateReserveRefillTransaction({
    transaction: decoded,
    policy,
    asset,
    expectedAmountUnits,
    nowSeconds,
    requireSignatures: true,
  });
  if (decoded instanceof FeeBumpTransaction) {
    throw new Error("reserve refill must not use a fee-bump envelope");
  }

  const hash = decoded.hash().toString("hex");
  log(`reserve refill hash: ${hash}`);
  log(`reserve refill explorer: ${explorerUrl()}/tx/${hash}`);

  const result = await submit(decoded);
  if (result.hash !== hash) {
    throw new Error(
      `Horizon returned a different hash; signed=${hash} returned=${result.hash}`,
    );
  }
  return { hash };
}
