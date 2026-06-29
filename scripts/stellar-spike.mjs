// ST-0 de-risk spike (issue #290) — prove the Stellar native-XLM payment rail on testnet.
//
// Throwaway/reference script. NOT app code and NOT wired into the build. It exists to
// document the known-good baseline that Wave 1 (ST-1a/ST-1b) builds on, and to capture the
// exact Horizon error shapes the payout/reconciler code must discriminate on.
//
// Requires `@stellar/stellar-sdk` (added to the app in ST-1a). To run before then, use a
// scratch workspace:
//   mkdir -p /tmp/stellar-spike && cd /tmp/stellar-spike && pnpm init && pnpm add @stellar/stellar-sdk
//   node "$OLDPWD/scripts/stellar-spike.mjs"   # $OLDPWD = the repo root you ran mkdir from
//
// Findings recorded on issue #290. Go/no-go: Stellar rail proven, ST-1a unblocked.
import {
  Keypair,
  Account,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Networks,
  BASE_FEE,
  StrKey,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet";

const server = new Horizon.Server(HORIZON_URL);
const log = (...a) => console.log(...a);

// --- conversion boundary (mirrors what lib/stellar/config.ts owns in ST-1a) ---
const STROOPS_PER_XLM = 10_000_000n; // 1 XLM = 10^7 stroops
const xlmToStroops = (xlm) => BigInt(Math.round(Number(xlm) * 1e7)).toString();
const stroopsToXlmString = (stroops) => {
  const s = BigInt(stroops);
  return `${s / STROOPS_PER_XLM}.${(s % STROOPS_PER_XLM).toString().padStart(7, "0")}`;
};

async function accountExists(pub) {
  try {
    await server.loadAccount(pub);
    return true;
  } catch {
    return false;
  }
}

// Friendbot is flaky from CI; retry transient failures, tolerate "already funded".
async function friendbotFund(pub) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) return res.json();
      const body = await res.text();
      if (res.status === 400 && (await accountExists(pub))) {
        log(`  friendbot: already funded (${pub.slice(0, 6)}…), continuing`);
        return { alreadyFunded: true };
      }
      throw new Error(`friendbot ${res.status}: ${body.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      log(`  friendbot attempt ${attempt} failed: ${e.message}; retrying…`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function nativeBalance(pub) {
  const acct = await server.loadAccount(pub);
  return acct.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

function buildPayment(srcKp, srcAccount, destPub, amountXlm) {
  const tx = new TransactionBuilder(srcAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: destPub, asset: Asset.native(), amount: amountXlm }),
    )
    .setTimeout(60)
    .build();
  tx.sign(srcKp);
  return tx;
}

(async () => {
  log("=== ST-0 Stellar testnet payment-rail spike ===");
  log("Horizon:", HORIZON_URL);

  // 1. keypairs + StrKey validation (case-sensitive base32 — see ST-4d hazard)
  const source = Keypair.random();
  const dest = Keypair.random();
  log("\n[keypairs]");
  log("source G:", source.publicKey());
  log("dest   G:", dest.publicKey());
  log("StrKey.isValidEd25519PublicKey(source):", StrKey.isValidEd25519PublicKey(source.publicKey()));

  // 2/3. fund both via friendbot (observe funded-vs-unfunded paths)
  log("\n[friendbot] funding source + dest…");
  await friendbotFund(source.publicKey());
  await friendbotFund(dest.publicKey());
  log("source balance:", await nativeBalance(source.publicKey()), "XLM");
  log("dest   balance:", await nativeBalance(dest.publicKey()), "XLM");

  // stroop-math boundary
  const amountStroops = "15000000"; // 1.5 XLM
  const amountXlm = stroopsToXlmString(amountStroops);
  log("\n[stroop math]", amountStroops, "stroops -> SDK amount", amountXlm, "XLM");
  log("[stroop math] xlmToStroops('1.5') =", xlmToStroops("1.5"));

  // 4/5. submit funded payment + confirm + finality timing
  log("\n[payment] source -> dest", amountXlm, "XLM");
  const t0 = Date.now();
  const sent = await server.submitTransaction(
    buildPayment(source, await server.loadAccount(source.publicKey()), dest.publicKey(), amountXlm),
  );
  log("hash:", sent.hash, "| submit->response ms:", Date.now() - t0);
  const rec = await server.transactions().transaction(sent.hash).call();
  log("Horizon successful:", rec.successful, "| ledger:", rec.ledger_attr, "| fee_charged:", rec.fee_charged);
  log("dest balance after:", await nativeBalance(dest.publicKey()), "XLM");
  log("explorer:", `${EXPLORER}/tx/${sent.hash}`);

  // 6a. unfunded destination -> op_no_destination (op-level code)
  log("\n[error] payment to a never-created G address…");
  const ghost = Keypair.random();
  try {
    await server.submitTransaction(
      buildPayment(source, await server.loadAccount(source.publicKey()), ghost.publicKey(), "1.0000000"),
    );
    log("  UNEXPECTED: succeeded");
  } catch (e) {
    log("  result_codes:", JSON.stringify(e?.response?.data?.extras?.result_codes));
  }

  // 6b. stale sequence -> tx_bad_seq (tx-level code, no operations array)
  log("\n[error] two differing txs on the same (stale) sequence…");
  const loaded = await server.loadAccount(source.publicKey());
  const seq = loaded.sequenceNumber();
  const a = buildPayment(source, new Account(source.publicKey(), seq), dest.publicKey(), "0.1000000");
  const b = buildPayment(source, new Account(source.publicKey(), seq), dest.publicKey(), "0.2000000");
  log("  submit #1:", (await server.submitTransaction(a)).successful ? "ok" : "fail");
  try {
    await server.submitTransaction(b);
    log("  submit #2: UNEXPECTED ok");
  } catch (e) {
    log("  submit #2 result_codes:", JSON.stringify(e?.response?.data?.extras?.result_codes));
  }

  log("\n=== go/no-go: Stellar rail proven, ST-1a unblocked ===");
})().catch((e) => {
  console.error("FATAL", e?.message || e);
  if (e?.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
