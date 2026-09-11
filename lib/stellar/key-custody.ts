// Single-deployment key custody for the payout account (F-01).
//
// The payout account is 2-of-3: master, ops signer, policy co-signer, each of
// weight 1, with all three thresholds at 2. The deliverable's security claim
// (CONTEXT.md, *Policy Co-signer*) is that "forging a payment requires
// compromising two isolated systems". That claim is about *custody*, and no
// existing guard tests custody:
//
//   - TC-002 asserts one **signer** cannot pay. True — each key is weight 1.
//   - `no-single-key-payout.test.ts` asserts no **code path** broadcasts an
//     under-signed envelope. True — the submitter always collects two.
//
// Both hold while a single deployment quietly holds two of the three seeds, at
// which point that deployment can assemble a valid 2-of-2 on its own and the
// co-signer is never contacted. That is an environment property, so the code
// guards cannot see it and a runbook line would not be enforced. It lives here
// as a refusal, in the same spirit as `cosigner-isolation.ts`.
//
// The rule deliberately counts *keys held*, not on-chain weight: reading weights
// would need a Horizon round trip inside config parsing, and would then trust
// the network to tell us whether we are safe. Counting seeds is local, total,
// and — while every signer is weight 1 against a threshold of 2 — exactly
// equivalent. `assertCustodyBelowThreshold` throws if that assumption is ever
// broken by a non-unit weight, rather than silently under-reporting.
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export type CustodyEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Every environment variable that can hold a seed which is a signer on the
 * payout account. `STELLAR_SPONSOR_SECRET` is deliberately absent: it is
 * required *not* to be a payout signer, which `assertSponsorNotPayoutSigner`
 * enforces separately.
 */
export const PAYOUT_SIGNER_SECRET_ENV_VARS = [
  "STELLAR_PLATFORM_SECRET",
  "STELLAR_OPS_SIGNER_SECRET",
  "STELLAR_POLICY_SIGNER_SECRET",
] as const;

/** Weight the payout account's thresholds require. Mirrors the 2/2/2 install. */
export const PAYOUT_THRESHOLD = 2;

function publicKeyOf(secret: string, name: string): string {
  try {
    return Keypair.fromSecret(secret.trim()).publicKey();
  } catch {
    throw new Error(`${name} must be a valid Stellar secret seed (S…)`);
  }
}

/**
 * The payout-account signer seeds this environment holds, by variable name.
 *
 * `STELLAR_PLATFORM_SECRET` counts only when it actually derives to
 * `STELLAR_PLATFORM_ACCOUNT` — i.e. when it is the payout account's master key.
 * A platform secret for some *other* account is not a signer here and must not
 * be counted, or the sponsorship key's own migration would trip this guard.
 */
export function heldPayoutSignerSecrets(
  env: CustodyEnvironment = process.env,
): string[] {
  const payoutAccount = env.STELLAR_PLATFORM_ACCOUNT?.trim();
  const held: string[] = [];

  for (const name of PAYOUT_SIGNER_SECRET_ENV_VARS) {
    const secret = env[name]?.trim();
    if (!secret) continue;

    if (name === "STELLAR_PLATFORM_SECRET") {
      // The master key is a signer on its own account and nowhere else.
      if (!payoutAccount) continue;
      if (publicKeyOf(secret, name) !== payoutAccount) continue;
    }
    held.push(name);
  }
  return held;
}

/**
 * Refuse an environment that holds enough of the payout account's seeds to reach
 * its threshold without the co-signer.
 *
 * Called from `parsePayoutSignerConfig`, so a deployment configured this way
 * cannot start a payout at all — it fails closed at the boundary rather than
 * succeeding with a signature set that was never independently authorised.
 */
export function assertCustodyBelowThreshold(
  env: CustodyEnvironment = process.env,
): void {
  const held = heldPayoutSignerSecrets(env);
  if (held.length < PAYOUT_THRESHOLD) return;

  throw new Error(
    `This deployment holds ${held.length} of the payout account's signing keys (${held.join(", ")}), which meets the ${PAYOUT_THRESHOLD}-of-3 threshold on its own — it could authorise a payment without ever contacting the policy co-signer, defeating the second-signature independence the payout account exists to provide. Remove all but one of them from this environment (F-01).`,
  );
}

/**
 * The sponsorship path signs trustline sandwiches, never payments, so its key
 * must not also be a payout-account signer. Keeping them separate is what lets
 * `STELLAR_PLATFORM_SECRET` come off `web` without breaking onboarding.
 */
export function assertSponsorNotPayoutSigner(
  env: CustodyEnvironment = process.env,
): void {
  const sponsorSecret = env.STELLAR_SPONSOR_SECRET?.trim();
  if (!sponsorSecret) return;

  const sponsorPublic = publicKeyOf(sponsorSecret, "STELLAR_SPONSOR_SECRET");
  const payoutAccount = env.STELLAR_PLATFORM_ACCOUNT?.trim();

  if (payoutAccount && sponsorPublic === payoutAccount) {
    throw new Error(
      "STELLAR_SPONSOR_SECRET must not be the payout account's master key — the sponsorship key exists so that this deployment can fund trustlines without holding a payout signer (F-01).",
    );
  }

  for (const name of ["STELLAR_OPS_SIGNER_SECRET", "STELLAR_POLICY_SIGNER_SECRET"] as const) {
    const secret = env[name]?.trim();
    if (!secret) continue;
    if (publicKeyOf(secret, name) === sponsorPublic) {
      throw new Error(
        `STELLAR_SPONSOR_SECRET must be independent of ${name} — reusing a payout signer as the sponsorship key puts a payout key back into this deployment (F-01).`,
      );
    }
  }

  if (!StrKey.isValidEd25519PublicKey(sponsorPublic)) {
    throw new Error("STELLAR_SPONSOR_SECRET did not derive a valid public key");
  }
}
