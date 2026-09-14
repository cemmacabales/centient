// Boot configuration for the deployed co-signer (issue #8).
//
// Every value here is required with no fallback, and that is the point. The
// tempting defaults are exactly the ones that would dissolve the separation the
// service exists to provide: falling back to `DATABASE_URL` would hand it the
// application's read-write connection, and falling back to
// `DAILY_PAYOUT_CAP_UNITS` would make the second cap the same cap. A co-signer
// that starts misconfigured is worse than one that refuses to start, because it
// still produces signatures.
import { Keypair } from "@stellar/stellar-sdk";
import { assertIsolationPermitted, type CoSignerIsolationLevel } from "./cosigner-isolation";
import { REPLAY_WINDOW_MS, type NonceStore } from "./cosigner-transport";

export type CoSignerEnvironment = Readonly<Record<string, string | undefined>>;

export interface CoSignerConfig {
  policy: Keypair;
  secret: string;
  capUnits: bigint;
  databaseUrl: string;
  isolation: CoSignerIsolationLevel;
  port: number;
}

const DEFAULT_PORT = 8080;

function required(env: CoSignerEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set for the policy co-signer to start`);
  }
  return value;
}

/**
 * The co-signer's own daily cap, in exact integer units.
 *
 * Zero is refused rather than treated as "no limit" the way the payout service's
 * cap is: this service exists to be a second, independent limit, and a
 * silently-disabled one would still answer every request with a signature.
 */
function capUnits(env: CoSignerEnvironment): bigint {
  const raw = required(env, "COSIGNER_DAILY_CAP_UNITS");
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new Error(`COSIGNER_DAILY_CAP_UNITS must be an integer number of units, got "${raw}"`);
  }
  if (parsed <= 0n) {
    throw new Error(`COSIGNER_DAILY_CAP_UNITS must be greater than zero, got "${raw}"`);
  }
  return parsed;
}

/** Resolve and validate everything the service needs, or refuse to start. */
export function resolveCoSignerConfig(env: CoSignerEnvironment = process.env): CoSignerConfig {
  const isolation = assertIsolationPermitted(env);

  const policy = Keypair.fromSecret(required(env, "STELLAR_POLICY_SIGNER_SECRET"));
  const advertised = env.STELLAR_POLICY_SIGNER_PUBLIC?.trim();
  if (advertised && advertised !== policy.publicKey()) {
    throw new Error(
      `STELLAR_POLICY_SIGNER_SECRET does not match STELLAR_POLICY_SIGNER_PUBLIC (${advertised}) — the payout service would reject every signature this key produces`,
    );
  }

  const port = Number(env.COSIGNER_PORT?.trim() || env.PORT?.trim() || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`COSIGNER_PORT must be a positive integer, got "${env.COSIGNER_PORT}"`);
  }

  return {
    policy,
    secret: required(env, "COSIGNER_SHARED_SECRET"),
    capUnits: capUnits(env),
    databaseUrl: required(env, "COSIGNER_DATABASE_URL"),
    isolation,
    port,
  };
}

/**
 * Single-use nonces, forgotten once they age past the replay window.
 *
 * Memory is bounded by that window rather than by a cap on entries: a nonce older
 * than the window cannot be replayed anyway, because `verifyCoSignRequest`
 * rejects its timestamp before ever consulting this store. Pruning on write keeps
 * it O(1) amortised without a timer.
 *
 * In-process, and therefore correct only while exactly one co-signer instance
 * runs — the same single-writer constraint the payout submitter carries. A second
 * replica needs shared storage here first.
 */
export function expiringNonceStore(now: () => number = Date.now): NonceStore {
  const seen = new Map<string, number>();
  return {
    take(nonce: string): boolean {
      const at = now();
      for (const [key, seenAt] of seen) {
        if (at - seenAt > REPLAY_WINDOW_MS) seen.delete(key);
        else break; // insertion-ordered: the rest are newer still
      }
      if (seen.has(nonce)) return false;
      seen.set(nonce, at);
      return true;
    },
  };
}
