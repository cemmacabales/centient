import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "./config";
import {
  evaluateMultisig,
  findUnexpectedActiveSigners,
  type AccountLike,
  type MultisigEvaluation,
  type SignerSet,
} from "./multisig";

type SetupEnvironment = Readonly<Record<string, string | undefined>>;
type SetupLog = (...values: unknown[]) => void;

function optionalPublicKey(
  env: SetupEnvironment,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  if (value && !StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${name} must be a valid Stellar public key`);
  }
  return value || undefined;
}

function optionalSecret(
  env: SetupEnvironment,
  name: string,
): Keypair | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  try {
    return Keypair.fromSecret(value);
  } catch {
    throw new Error(`${name} must be a valid Stellar secret seed`);
  }
}

function generatedKey(
  label: string,
  publicEnvName: string,
  secretEnvName: string,
  log: SetupLog,
) {
  const key = Keypair.random();
  log(`WARNING: generated a disposable testnet ${label}; move it now:`);
  log(`${publicEnvName}=${key.publicKey()}`);
  log(`${secretEnvName}=${key.secret()}`);
  return key;
}

/** Resolve setup identities before any account funding or on-chain mutation. */
export function resolveColdReserveSetupKeys({
  env,
  network,
  log,
}: {
  env: SetupEnvironment;
  network: StellarNetwork;
  log: SetupLog;
}): { master: Keypair; opsPublic: string; policyPublic: string } {
  const generationSetting = env.STELLAR_ALLOW_TESTNET_KEY_GENERATION?.trim();
  if (
    generationSetting &&
    generationSetting !== "true" &&
    generationSetting !== "false"
  ) {
    throw new Error(
      "STELLAR_ALLOW_TESTNET_KEY_GENERATION must be true or false",
    );
  }
  const allowGeneration = generationSetting === "true";
  if (allowGeneration && network !== "testnet") {
    throw new Error(
      "STELLAR_ALLOW_TESTNET_KEY_GENERATION is permitted only on testnet",
    );
  }

  let master = optionalSecret(env, "STELLAR_COLD_RESERVE_SECRET");
  if (!master) {
    if (!allowGeneration) {
      throw new Error("STELLAR_COLD_RESERVE_SECRET is required");
    }
    master = generatedKey(
      "cold_master",
      "STELLAR_COLD_RESERVE_ACCOUNT",
      "STELLAR_COLD_RESERVE_SECRET",
      log,
    );
  }

  const configuredCold = optionalPublicKey(
    env,
    "STELLAR_COLD_RESERVE_ACCOUNT",
  );
  if (configuredCold && configuredCold !== master.publicKey()) {
    throw new Error(
      "STELLAR_COLD_RESERVE_ACCOUNT must match STELLAR_COLD_RESERVE_SECRET",
    );
  }

  const explicitHot = optionalPublicKey(env, "STELLAR_PLATFORM_ACCOUNT");
  const hotKey = optionalSecret(env, "STELLAR_PLATFORM_SECRET");
  const hotFromSecret = hotKey?.publicKey();
  if (explicitHot && hotFromSecret && explicitHot !== hotFromSecret) {
    throw new Error(
      "STELLAR_PLATFORM_ACCOUNT must match STELLAR_PLATFORM_SECRET",
    );
  }
  const hotPublic = explicitHot ?? hotFromSecret;
  if (!hotPublic) {
    throw new Error(
      "STELLAR_PLATFORM_ACCOUNT or STELLAR_PLATFORM_SECRET is required before cold setup",
    );
  }
  if (hotPublic === master.publicKey()) {
    throw new Error("cold reserve and hot wallet must be distinct accounts");
  }

  let opsPublic = optionalPublicKey(
    env,
    "STELLAR_COLD_OPS_SIGNER_PUBLIC",
  );
  if (!opsPublic) {
    if (!allowGeneration) {
      throw new Error("STELLAR_COLD_OPS_SIGNER_PUBLIC is required");
    }
    opsPublic = generatedKey(
      "cold_ops",
      "STELLAR_COLD_OPS_SIGNER_PUBLIC",
      "COLD_OPS_SIGNER_SECRET",
      log,
    ).publicKey();
  }

  let policyPublic = optionalPublicKey(
    env,
    "STELLAR_COLD_POLICY_SIGNER_PUBLIC",
  );
  if (!policyPublic) {
    if (!allowGeneration) {
      throw new Error("STELLAR_COLD_POLICY_SIGNER_PUBLIC is required");
    }
    policyPublic = generatedKey(
      "cold_policy",
      "STELLAR_COLD_POLICY_SIGNER_PUBLIC",
      "COLD_POLICY_SIGNER_SECRET",
      log,
    ).publicKey();
  }

  const identities = [master.publicKey(), hotPublic, opsPublic, policyPublic];
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      "cold reserve, hot wallet, ops signer, and policy signer must be distinct",
    );
  }

  return { master, opsPublic, policyPublic };
}

/** Fail closed unless Horizon reports exactly the intended three active keys. */
export function assertColdReserveMultisig(
  account: AccountLike,
  signerSet: SignerSet,
): MultisigEvaluation {
  const evaluation = evaluateMultisig(account, signerSet);
  if (!evaluation.matchesTarget) {
    throw new Error(
      `cold reserve does not match exact target 2-of-3: ${evaluation.reasons.join("; ")}`,
    );
  }
  return evaluation;
}

/** Refuse automatic setup when an existing signer needs explicit removal. */
export function evaluateColdReserveSetupState(
  account: AccountLike,
  signerSet: SignerSet,
): MultisigEvaluation {
  const unexpected = findUnexpectedActiveSigners(account, signerSet);
  if (unexpected.length > 0) {
    throw new Error(
      `cold reserve has unexpected active signer(s) ${unexpected
        .map((signer) => signer.key)
        .join(", ")}; use the authorized manual signer-removal recovery flow`,
    );
  }
  return evaluateMultisig(account, signerSet);
}
