// Testnet proof runner for the multisig payout service (issue #7 DoD, tracked
// in #73): drive the real `payReward` path end to end — cap check, platform
// signature, independent co-signature, fee-bump, sequence-safe submit — and
// print the resulting hash. Sibling of `stellar-multisig-payout-spike.ts`,
// which proved the raw helpers before the service existed.
//
// Testnet only. The gated local co-signer this relies on is refused on the
// public network, so this runner cannot be pointed at real funds.
//
// Usage:
//   STELLAR_ALLOW_LOCAL_COSIGNER=true DAILY_PAYOUT_CAP_UNITS=0 \
//   npx tsx scripts/stellar-payout-service-proof.ts <G destination> <amount units> <reference id>
import "dotenv/config";
import { payReward } from "../lib/payout";
import { stellarNetwork } from "../lib/stellar/config";
import { assertPayoutAmountUnits, assertPayoutDestination } from "../lib/stellar/payout-amount";

// Printed as evidence, so it must name the network the transaction actually
// settled on. `explorerUrl()` honours NEXT_PUBLIC_EXPLORER_URL, which an
// operator's environment may point at another network; this runner is testnet
// only, so the link is pinned to the testnet explorer.
const TESTNET_EXPLORER = "https://stellar.expert/explorer/testnet";

/** Operator-visible evidence only; never a seed. */
const log = (message: string) => console.log(message);

async function main() {
  if (stellarNetwork() !== "testnet") {
    throw new Error("the payout-service proof runner is testnet only");
  }
  const [destination, rawUnits, reference] = process.argv.slice(2);
  if (!destination || !rawUnits || !reference) {
    throw new Error(
      "usage: stellar-payout-service-proof.ts <G destination> <amount units> <reference id>",
    );
  }
  assertPayoutDestination(destination, "destination");
  const amountUnits = BigInt(rawUnits);
  assertPayoutAmountUnits(amountUnits, "amount units");

  log(`network: ${stellarNetwork()}`);
  log(`destination: ${destination}`);
  log(`amount units: ${amountUnits}`);
  log(`reference: payout_job:${reference}`);

  const hash = await payReward(destination, amountUnits, { kind: "payout_job", id: reference });

  log(`hash: ${hash}`);
  log(`explorer: ${TESTNET_EXPLORER}/tx/${hash}`);
}

main().catch((error) => {
  console.error("PAYOUT SERVICE PROOF FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
