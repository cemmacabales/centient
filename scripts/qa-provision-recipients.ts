// Provision the three pinned D1 recipient accounts on Stellar Testnet, once.
//
// Run this when the manifest does not exist or its accounts have been lost. It
// writes `lib/qa-fixtures/recipients.testnet.json`, which is committed, so the
// seed command never touches the network and every run pays the same addresses.
//
// It needs no platform, sponsor, or issuer secret. Each recipient's keypair is
// generated here and signs its own trustline; friendbot supplies the XLM. The
// only secret that exists is the recipient's own, it is used for one transaction,
// and it is never written anywhere — the manifest holds public keys only.
//
// The zero-XLM sponsored shape is NOT provisioned here. D1-TC-006 tests the
// sponsorship event itself, which happens exactly once per address, so a pinned
// account would make that case unobservable. It is minted per-run by its own
// command.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { horizonUrl, networkPassphrase, usdcAsset } from "../lib/stellar/config";
import { requireTestnet } from "../lib/qa-fixtures/gate";
import { defaultManifestPath, parseRecipientManifest } from "../lib/qa-fixtures/manifest";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

function log(message: string): void {
  console.log(`[qa-provision] ${message}`);
}

async function friendbotFund(publicKey: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
    if (response.ok) return;
    // Friendbot answers 400 for an account it has already funded, which is a
    // success for our purposes — the account exists and holds XLM.
    const body = await response.text();
    if (response.status === 400 && body.includes("createAccountAlreadyExist")) {
      log(`  ${publicKey.slice(0, 8)}… already funded`);
      return;
    }
    if (attempt === 4) {
      throw new Error(`friendbot funding failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
    }
    log(`  friendbot attempt ${attempt} failed (HTTP ${response.status}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function addTrustline(
  server: Horizon.Server,
  keypair: Keypair,
  asset: Asset,
): Promise<string> {
  const account = await server.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

async function main(): Promise<void> {
  // The same refusal the fixture commands use. This one mints keys and funds
  // accounts, so pointing it at the public network would be worse than useless.
  requireTestnet();

  const asset = usdcAsset();
  const server = new Horizon.Server(horizonUrl());
  log(`network: testnet · horizon: ${horizonUrl()}`);
  log(`USDC asset: ${asset.getCode()} / ${asset.getIssuer()}`);

  // ── withTrustline: funded, holds the USDC trustline ──────────────────────
  const withTrustline = Keypair.random();
  log(`withTrustline  ${withTrustline.publicKey()}`);
  await friendbotFund(withTrustline.publicKey());
  const trustlineHash = await addTrustline(server, withTrustline, asset);
  log(`  trustline established in ${trustlineHash}`);

  // ── withoutTrustline: funded, deliberately no trustline ──────────────────
  const withoutTrustline = Keypair.random();
  log(`withoutTrustline ${withoutTrustline.publicKey()}`);
  await friendbotFund(withoutTrustline.publicKey());
  log("  funded, no trustline added — this is the op_no_trust case");

  // ── neverCreated: a valid key that has never existed on-chain ────────────
  const neverCreated = Keypair.random();
  log(`neverCreated   ${neverCreated.publicKey()} (never funded, by design)`);

  const manifest = {
    network: "testnet",
    usdcIssuer: asset.getIssuer(),
    generatedAt: new Date().toISOString(),
    recipients: {
      withTrustline: {
        address: withTrustline.publicKey(),
        note: `Funded via friendbot; USDC trustline established in ${trustlineHash}.`,
      },
      withoutTrustline: {
        address: withoutTrustline.publicKey(),
        note: "Funded via friendbot; no USDC trustline. Expect op_no_trust.",
      },
      neverCreated: {
        address: neverCreated.publicKey(),
        note: "Never created on-chain. Expect a no-destination classification.",
      },
    },
  };

  // Validated before writing: a manifest that fails its own parser would be
  // discovered by the seed command instead, long after the accounts were made.
  parseRecipientManifest(manifest);

  const path = defaultManifestPath();
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  log(`wrote ${path}`);
  log("commit this file — the seed command reads it and makes no network calls.");
}

main().catch((error) => {
  console.error(`[qa-provision] failed: ${(error as Error).message}`);
  process.exit(1);
});
