// The deployment topology the co-signer is permitted to run under (ADR-0001).
//
// Issue #8 asks for a co-signer on infrastructure isolated from the payout
// service. For the MVP it runs in its own Railway project inside the existing
// workspace, which buys a separate container, variable scope, deploy trigger,
// member list, and database credential — but not a separate account, CI, or
// database instance. That is a real boundary against an application compromise
// and no boundary at all against a control-plane compromise.
//
// Accepting that trade while no real funds move is a decision. Letting it survive
// into mainnet would be an accident, so the limit lives here as a refusal rather
// than in a runbook: the simulated boundary is never permitted on `public`.
import { stellarNetwork } from "./config";

export type CoSignerIsolationLevel = "same-workspace" | "separate-account";

export type CoSignerIsolationEnvironment = Readonly<Record<string, string | undefined>>;

const LEVELS: readonly CoSignerIsolationLevel[] = ["same-workspace", "separate-account"];

/**
 * The declared isolation level. There is deliberately no default: every possible
 * guess is wrong in a way nothing else would catch — assuming `separate-account`
 * lets a shared workspace sign mainnet payouts, and assuming `same-workspace`
 * refuses a correctly isolated deployment. The deployment must say which it is.
 */
export function cosignerIsolationLevel(
  env: CoSignerIsolationEnvironment = process.env,
): CoSignerIsolationLevel {
  const raw = env.COSIGNER_ISOLATION_LEVEL?.trim();
  if (!raw) {
    throw new Error(
      `COSIGNER_ISOLATION_LEVEL must be set to one of ${LEVELS.join(" | ")} — the co-signer's deployment topology is never assumed (ADR-0001)`,
    );
  }
  if (!LEVELS.includes(raw as CoSignerIsolationLevel)) {
    throw new Error(
      `COSIGNER_ISOLATION_LEVEL must be one of ${LEVELS.join(" | ")}, got "${raw}"`,
    );
  }
  return raw as CoSignerIsolationLevel;
}

/**
 * Refuse a topology this network does not permit.
 *
 * The network is read from `stellarNetwork()` — the same authority that scopes
 * the signature itself — so a caller cannot claim testnet while signing public
 * payouts, and an empty setting throws there rather than slipping past by simply
 * not equalling "public".
 */
export function assertIsolationPermitted(
  env: CoSignerIsolationEnvironment = process.env,
): CoSignerIsolationLevel {
  const level = cosignerIsolationLevel(env);
  if (level === "same-workspace" && stellarNetwork() === "public") {
    throw new Error(
      "COSIGNER_ISOLATION_LEVEL=same-workspace is never permitted on the public network — mainnet requires the co-signer on a separate account (ADR-0001)",
    );
  }
  return level;
}
