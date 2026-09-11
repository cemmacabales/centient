// Verify the payout account's native multisig on-chain via Horizon — issue #2.
//
// Read-only: loads the account, runs the shared evaluateMultisig predicate
// (lib/stellar/multisig.ts), prints the signer set + thresholds and the
// stellar.expert links, and exits non-zero if the Definition of Done is not met
// (med/high ≥ 2, ≥ 2 independent signers, master weight below the threshold).
//
// Safe to run repeatedly / in CI. This is the "verify on-chain via Horizon"
// deliverable and the check a reviewer can re-run against the recorded account.
//
// Usage:
//   STELLAR_PLATFORM_ACCOUNT=G… \
//   STELLAR_OPS_SIGNER_PUBLIC=G… \
//   STELLAR_POLICY_SIGNER_PUBLIC=G… \
//     pnpm stellar:multisig:verify
//
// The account may be given as STELLAR_PLATFORM_ACCOUNT (public key), or derived
// from STELLAR_PLATFORM_SECRET when only the secret is at hand.
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { server, explorerUrl } from "../lib/stellar/config";
import { evaluateMultisig, type AccountLike } from "../lib/stellar/multisig";

const log = (...a: unknown[]) => console.log(...a);

function resolveAccountId(): string {
  const explicit = process.env.STELLAR_PLATFORM_ACCOUNT?.trim();
  if (explicit) {
    if (!StrKey.isValidEd25519PublicKey(explicit)) {
      throw new Error(`STELLAR_PLATFORM_ACCOUNT must be a valid public key (G…), got "${explicit}"`);
    }
    return explicit;
  }
  const secret = process.env.STELLAR_PLATFORM_SECRET?.trim();
  if (secret && secret.startsWith("S")) return Keypair.fromSecret(secret).publicKey();
  throw new Error(
    "Set STELLAR_PLATFORM_ACCOUNT (G… public key) or STELLAR_PLATFORM_SECRET to identify the payout account.",
  );
}

/** Require a co-signer public key from env — the verifier asserts the intended
 *  2-of-3, so a missing/typoed key must fail loudly rather than pass on "any 2". */
function requireSignerPublic(envVar: string): string {
  const value = process.env[envVar]?.trim();
  if (!value || !StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${envVar} must be set to a valid Stellar public key (G…) to verify the payout multisig, got "${value ?? ""}"`);
  }
  return value;
}

async function main() {
  const accountId = resolveAccountId();
  const opsPublic = requireSignerPublic("STELLAR_OPS_SIGNER_PUBLIC");
  const policyPublic = requireSignerPublic("STELLAR_POLICY_SIGNER_PUBLIC");

  const account = (await server().loadAccount(accountId)) as unknown as AccountLike;

  log("=== Payout multisig verification ===");
  log("account :", accountId);
  log("explorer:", `${explorerUrl()}/account/${accountId}`);
  log("");
  log("Thresholds:", account.thresholds);
  log("Signers:");
  for (const s of account.signers) {
    const role = s.key === accountId ? "master" : "co-signer";
    log(`  ${s.key}  weight=${s.weight}  (${role})`);
  }

  const { satisfiesDod, reasons } = evaluateMultisig(account, {
    masterPublic: accountId,
    opsPublic,
    policyPublic,
  });

  log("");
  if (satisfiesDod) {
    log("✅ Definition of Done met: payments require ≥ 2 signatures; master alone cannot pay.");
    return;
  }
  log("❌ Definition of Done NOT met:");
  for (const r of reasons) log(`  - ${r}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("MULTISIG VERIFY FAILED:", (e as Error)?.message ?? e);
  process.exit(1);
});
