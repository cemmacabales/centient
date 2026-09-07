// Configure the payout (hot) account as a native Stellar 2-of-3 multisig — issue #2.
//
// Applies one setOptions transaction that adds two independent co-signers (ops,
// policy) at weight 1, lowers the master weight to 1, and sets low/med/high
// thresholds to 2. After this, any 2 of the 3 keys sign a payment and the master
// alone cannot — proven downstream by scripts/stellar-multisig-verify.ts.
//
// The transaction shape lives in lib/stellar/multisig.ts (buildSetOptionsTx),
// shared with the verifier and unit-tested, so this script is just orchestration:
// resolve keys, fund on testnet, no-op if already configured, otherwise submit.
//
// Idempotent: re-running once the account already matches the target prints
// "already configured" and exits 0 without submitting.
//
// Usage:
//   pnpm stellar:multisig:setup            # generate a throwaway master + signers
//   STELLAR_PLATFORM_SECRET=S… \
//   STELLAR_OPS_SIGNER_PUBLIC=G… \
//   STELLAR_POLICY_SIGNER_PUBLIC=G… \
//     pnpm stellar:multisig:setup          # reuse existing keys
//
// Only PUBLIC keys of the co-signers are consumed here; their secrets are held in
// a secrets store and injected at signing time (issue #3) — never committed.
import { Keypair } from "@stellar/stellar-sdk";
import { server, explorerUrl, stellarNetwork } from "../lib/stellar/config";
import {
  buildSetOptionsTx,
  evaluateMultisig,
  type AccountLike,
} from "../lib/stellar/multisig";

const FRIENDBOT = "https://friendbot.stellar.org";
const log = (...a: unknown[]) => console.log(...a);

async function accountExists(pub: string): Promise<boolean> {
  try {
    await server().loadAccount(pub);
    return true;
  } catch {
    return false;
  }
}

async function friendbotFund(pub: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) return;
      if (res.status === 400 && (await accountExists(pub))) return;
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error("friendbot funding failed after retries");
}

/** Resolve a co-signer public key from env, or generate a throwaway and print it. */
function resolveSigner(label: string, envVar: string): string {
  const provided = process.env[envVar]?.trim();
  if (provided) {
    log(`${label} signer: ${provided} (from ${envVar})`);
    return provided;
  }
  const kp = Keypair.random();
  log("");
  log(`⚠️  Generated a throwaway ${label} signer — STORE THE SECRET IN YOUR SECRETS MANAGER:`);
  log(`    ${envVar}=${kp.publicKey()}`);
  log(`    ${label.toUpperCase()}_SIGNER_SECRET=${kp.secret()}   (do NOT commit)`);
  log("");
  return kp.publicKey();
}

async function main() {
  const network = stellarNetwork();
  log("=== Stellar payout multisig setup (2-of-3) ===");
  log("Network :", network);

  const providedSecret = process.env.STELLAR_PLATFORM_SECRET?.trim();
  const master =
    providedSecret && providedSecret.startsWith("S")
      ? Keypair.fromSecret(providedSecret)
      : Keypair.random();
  if (!providedSecret || !providedSecret.startsWith("S")) {
    log("");
    log("⚠️  No STELLAR_PLATFORM_SECRET — generated a throwaway master. STORE IT:");
    log(`    STELLAR_PLATFORM_SECRET=${master.secret()}`);
    log("");
  }
  log("Master  :", master.publicKey());

  if (!(await accountExists(master.publicKey()))) {
    if (network !== "testnet") {
      throw new Error(
        `Master account ${master.publicKey()} does not exist on ${network}; fund it before running.`,
      );
    }
    log("Funding master via friendbot (testnet)…");
    await friendbotFund(master.publicKey());
  }

  const opsPublic = resolveSigner("ops", "STELLAR_OPS_SIGNER_PUBLIC");
  const policyPublic = resolveSigner("policy", "STELLAR_POLICY_SIGNER_PUBLIC");

  const account = await server().loadAccount(master.publicKey());
  const evaluation = evaluateMultisig(account as unknown as AccountLike, {
    masterPublic: master.publicKey(),
    opsPublic,
    policyPublic,
  });

  if (evaluation.matchesTarget) {
    log("");
    log("✅ Already configured as the target 2-of-3 multisig — nothing to submit.");
    log("Explorer:", `${explorerUrl()}/account/${master.publicKey()}`);
    return;
  }

  log("");
  log("Submitting setOptions: +ops(w=1) +policy(w=1) masterWeight=1 low/med/high=2 …");
  const tx = buildSetOptionsTx({ account, masterKey: master, opsPublic, policyPublic });
  tx.sign(master);
  const res = await server().submitTransaction(tx);

  log("");
  log("✅ Multisig configured.");
  log("tx hash :", res.hash);
  log("tx      :", `${explorerUrl()}/tx/${res.hash}`);
  log("account :", `${explorerUrl()}/account/${master.publicKey()}`);
  log("");
  log("Next: run `pnpm stellar:multisig:verify` to assert the config on-chain.");
}

main().catch((e) => {
  const detail =
    (e as { response?: { data?: { extras?: unknown } } })?.response?.data?.extras ??
    (e as { response?: { data?: unknown } })?.response?.data ??
    (e as Error)?.message ??
    e;
  console.error("MULTISIG SETUP FAILED:", detail);
  process.exit(1);
});
