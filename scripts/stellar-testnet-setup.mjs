// One-shot testnet setup for the platform (payout) account.
//
// Generates (or reuses) a Stellar testnet keypair, friendbot-funds it with XLM,
// and adds its USDC trustline so the payout rail can hold + send USDC. Prints the
// account's public key and the exact next step (faucet USDC into it).
//
// Usage:
//   node scripts/stellar-testnet-setup.mjs                 # generate a fresh throwaway
//   STELLAR_PLATFORM_SECRET=S... node scripts/stellar-testnet-setup.mjs   # reuse one
//
// Env (falls back to sensible testnet defaults):
//   STELLAR_USDC_ISSUER   default: Circle testnet USDC issuer
//   STELLAR_USDC_CODE     default: USDC
//   STELLAR_HORIZON_URL   default: https://horizon-testnet.stellar.org
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const USDC_ISSUER =
  process.env.STELLAR_USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_CODE = process.env.STELLAR_USDC_CODE ?? "USDC";

const server = new Horizon.Server(HORIZON_URL);
const log = (...a) => console.log(...a);

async function accountExists(pub) {
  try {
    await server.loadAccount(pub);
    return true;
  } catch {
    return false;
  }
}

async function friendbotFund(pub) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) return;
      if (res.status === 400 && (await accountExists(pub))) {
        log("  friendbot: already funded, continuing");
        return;
      }
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error("friendbot funding failed after retries");
}

async function hasTrustline(pub, asset) {
  const acct = await server.loadAccount(pub);
  return acct.balances.some(
    (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}

async function addTrustline(kp, asset) {
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return server.submitTransaction(tx);
}

async function main() {
  const providedSecret = process.env.STELLAR_PLATFORM_SECRET;
  const kp = providedSecret ? Keypair.fromSecret(providedSecret) : Keypair.random();
  const asset = new Asset(USDC_CODE, USDC_ISSUER);

  log("=== Stellar testnet platform account setup ===");
  log("Horizon :", HORIZON_URL);
  log("USDC    :", `${USDC_CODE}:${USDC_ISSUER.slice(0, 6)}…`);
  log("");

  if (!(await accountExists(kp.publicKey()))) {
    log("Funding account with XLM via friendbot…");
    await friendbotFund(kp.publicKey());
    log("  funded.");
  } else {
    log("Account already exists on testnet.");
  }

  if (await hasTrustline(kp.publicKey(), asset)) {
    log("USDC trustline already present.");
  } else {
    log("Adding USDC trustline…");
    const res = await addTrustline(kp, asset);
    log("  trustline set. tx:", `${EXPLORER}/tx/${res.hash}`);
  }

  const acct = await server.loadAccount(kp.publicKey());
  const xlm = acct.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
  const usdc =
    acct.balances.find(
      (b) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
    )?.balance ?? "0";

  log("");
  log("================= PLATFORM ACCOUNT =================");
  log("PUBLIC KEY :", kp.publicKey());
  log("SECRET     :", kp.secret());
  log("XLM balance:", xlm);
  log("USDC balance:", usdc);
  log("Explorer   :", `${EXPLORER}/account/${kp.publicKey()}`);
  log("===================================================");
  log("");
  log("NEXT STEPS:");
  log("  1. Put the SECRET above in .env.local as STELLAR_PLATFORM_SECRET=");
  log("  2. Faucet testnet USDC into the PUBLIC KEY above:");
  log("       https://faucet.circle.com  (choose network: Stellar Testnet)");
  log("     A few USDC is plenty for the demo.");
  log("  3. Re-run this script anytime with STELLAR_PLATFORM_SECRET set to check balances.");
}

main().catch((e) => {
  console.error("SETUP FAILED:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
