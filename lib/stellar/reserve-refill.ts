import { type Asset, Keypair, StrKey } from "@stellar/stellar-sdk";

export interface ReserveRefillPolicy {
  coldAccount: string;
  hotAccount: string;
  signerPublicKeys: readonly [string, string, string];
  triggerUnits: bigint;
  targetUnits: bigint;
  minRetainUnits: bigint;
}

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

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requirePublicKey(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name).trim();
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${name} must be a valid Stellar public key (G…)`);
  }
  return value;
}

function requireUnits(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = requireEnv(env, name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer unit string`);
  }
  return BigInt(value);
}

export function parseReserveRefillPolicy(
  env: NodeJS.ProcessEnv = process.env,
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
