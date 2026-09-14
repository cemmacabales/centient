// E1-2 (#6) — prove the complete multisig USDC payout path on Stellar testnet.
//
// The runner is intentionally testnet-only. It:
//   1. creates the payout account's USDC trustline with master + ops signatures;
//   2. creates a fresh zero-XLM recipient and sponsors its account + trustline;
//   3. builds one USDC payment, merges master + ops signatures on the inner tx;
//   4. wraps it in a payout-account-funded fee bump with two outer signatures;
//   5. submits once and asserts the resulting Horizon evidence.
//
// If the payout account has no testnet USDC, the first run creates its trustline
// and exits with the exact Circle faucet address. Fund it, then rerun.
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  type Asset,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  explorerUrl,
  networkPassphrase,
  server,
  stellarNetwork,
  unitsToUsdcString,
  usdcAsset,
  usdcToUnits,
} from "../lib/stellar/config";
import {
  addIndependentSignatures,
  buildMultisigFeeBump,
  buildUsdcPaymentTx,
  verifyPayoutEvidence,
} from "../lib/stellar/multisig-payout";
import {
  evaluateMultisig,
  type AccountLike,
} from "../lib/stellar/multisig";
import { buildSponsoredRecipientTx } from "../lib/stellar/sponsored-recipient";

const DEFAULT_PAYOUT_AMOUNT = "1";
const TX_TIMEOUT_SECONDS = 180;
const CIRCLE_FAUCET = "https://faucet.circle.com/?allow=true";
const STELLAR_DECIMAL_SCALE = 10_000_000n;
const log = (...values: unknown[]) => console.log(...values);
type AccountResponse = Awaited<ReturnType<ReturnType<typeof server>["loadAccount"]>>;

function requiredKeypair(name: string): Keypair {
  const secret = process.env[name]?.trim();
  if (!secret) throw new Error(`${name} is not configured`);
  return Keypair.fromSecret(secret);
}

function requiredPublicKey(name: string): string {
  const publicKey = process.env[name]?.trim();
  if (!publicKey) throw new Error(`${name} is not configured`);
  return publicKey;
}

function assetBalanceUnits(
  account: AccountResponse,
  asset: Asset,
): bigint {
  const line = account.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      "asset_code" in balance &&
      balance.asset_code === asset.getCode() &&
      balance.asset_issuer === asset.getIssuer(),
  );
  return line ? usdcToUnits(line.balance) : 0n;
}

function nativeBalanceUnits(account: AccountResponse): bigint {
  const line = account.balances.find((balance) => balance.asset_type === "native");
  if (!line) return 0n;

  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(line.balance.trim());
  if (!match) {
    throw new Error(`invalid Stellar native balance "${line.balance}"`);
  }
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(7, "0"));
  return whole * STELLAR_DECIMAL_SCALE + fraction;
}

/**
 * Submit a transaction exactly once, printing its hash *before* the network
 * call. A submission whose outcome is unknown (timeout, dropped connection)
 * must then be reconciled against this hash — never blindly resubmitted, which
 * on a reused sequence number risks paying twice.
 */
async function submitOnce(
  label: string,
  transaction: Transaction | FeeBumpTransaction,
): Promise<string> {
  const hash = transaction.hash().toString("hex");
  log(`${label} hash    :`, hash);
  log(`${label} explorer:`, `${explorerUrl()}/tx/${hash}`);
  const submitted = await server().submitTransaction(transaction);
  if (!submitted.successful) {
    throw new Error(`${label} was included but failed on-chain: ${hash}`);
  }
  if (submitted.hash !== hash) {
    throw new Error(
      `${label} hash mismatch: signed ${hash}, Horizon reported ${submitted.hash}`,
    );
  }
  return hash;
}

async function ensurePayoutTrustline({
  master,
  ops,
  asset,
}: {
  master: Keypair;
  ops: Keypair;
  asset: Asset;
}): Promise<string | null> {
  const horizon = server();
  const account = await horizon.loadAccount(master.publicKey());
  const hasTrustline = account.balances.some(
    (balance) =>
      balance.asset_type !== "native" &&
      "asset_code" in balance &&
      balance.asset_code === asset.getCode() &&
      balance.asset_issuer === asset.getIssuer(),
  );
  if (hasTrustline) return null;

  const fee = String(await horizon.fetchBaseFee().catch(() => Number(BASE_FEE)));
  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  addIndependentSignatures(tx, [master, ops]);
  return submitOnce("payout trustline", tx);
}

async function main(): Promise<void> {
  if (stellarNetwork() !== "testnet") {
    throw new Error("This spike is testnet-only; set STELLAR_NETWORK=testnet");
  }

  const master = requiredKeypair("STELLAR_PLATFORM_SECRET");
  const ops = requiredKeypair("STELLAR_OPS_SIGNER_SECRET");
  const opsPublic = requiredPublicKey("STELLAR_OPS_SIGNER_PUBLIC");
  const policyPublic = requiredPublicKey("STELLAR_POLICY_SIGNER_PUBLIC");
  if (ops.publicKey() !== opsPublic) {
    throw new Error("STELLAR_OPS_SIGNER_SECRET does not match STELLAR_OPS_SIGNER_PUBLIC");
  }

  const amountUnits = usdcToUnits(
    process.env.STELLAR_SPIKE_AMOUNT_USDC?.trim() || DEFAULT_PAYOUT_AMOUNT,
  );
  if (amountUnits <= 0n) throw new Error("STELLAR_SPIKE_AMOUNT_USDC must be positive");

  const asset = usdcAsset();
  const horizon = server();
  const payoutPublicKey = master.publicKey();
  const payoutAccount = await horizon.loadAccount(payoutPublicKey);
  const multisig = evaluateMultisig(payoutAccount as unknown as AccountLike, {
    masterPublic: payoutPublicKey,
    opsPublic,
    policyPublic,
  });
  if (!multisig.satisfiesDod) {
    throw new Error(`payout multisig failed safety gate: ${multisig.reasons.join("; ")}`);
  }

  log("=== E1-2 multisig USDC payout spike ===");
  log("network        : testnet");
  log("payout account :", payoutPublicKey);
  log("payout amount  :", unitsToUsdcString(amountUnits), "USDC");

  const trustlineHash = await ensurePayoutTrustline({ master, ops, asset });
  if (!trustlineHash) log("payout trustline   : already present");

  const fundedPayout = await horizon.loadAccount(payoutPublicKey);
  const payoutUsdcUnits = assetBalanceUnits(fundedPayout, asset);
  if (payoutUsdcUnits < amountUnits) {
    throw new Error(
      [
        "PAYOUT_SPIKE_NEEDS_USDC",
        `Payout account ${payoutPublicKey} has ${unitsToUsdcString(payoutUsdcUnits)} testnet USDC.`,
        `Request 20 USDC on Stellar Testnet at ${CIRCLE_FAUCET}, then rerun.`,
      ].join(" "),
    );
  }

  const recipient = Keypair.random();
  const fee = String(await horizon.fetchBaseFee().catch(() => Number(BASE_FEE)));
  const sponsorTx = buildSponsoredRecipientTx({
    sponsorAccount: await horizon.loadAccount(payoutPublicKey),
    recipientPublicKey: recipient.publicKey(),
    asset,
    fee,
  });
  addIndependentSignatures(sponsorTx, [master, ops, recipient], 3);
  const sponsorHash = await submitOnce("sponsor", sponsorTx);

  const recipientBefore = await horizon.loadAccount(recipient.publicKey());
  const recipientUsdcBeforeUnits = assetBalanceUnits(recipientBefore, asset);
  const recipientXlmBeforeUnits = nativeBalanceUnits(recipientBefore);

  const innerPayment = buildUsdcPaymentTx({
    sourceAccount: await horizon.loadAccount(payoutPublicKey),
    destination: recipient.publicKey(),
    asset,
    amountUnits,
    fee,
  });
  addIndependentSignatures(innerPayment, [master, ops]);

  const feeBump = buildMultisigFeeBump({
    feeSource: payoutPublicKey,
    baseFee: fee,
    innerTransaction: innerPayment,
    requiredSignerPublicKeys: [payoutPublicKey, opsPublic],
  });
  addIndependentSignatures(feeBump, [master, ops]);

  // Submit exactly once. Unknown outcomes must be reconciled by hash, never
  // blindly retried; #7 owns sequence-safe production submission behavior.
  const payoutHash = await submitOnce("payout fee-bump", feeBump);
  const transaction = await horizon.transactions().transaction(payoutHash).call();
  if (!transaction.successful) {
    throw new Error(`payout fee-bump ${payoutHash} is recorded as failed on-chain`);
  }
  const recipientAfter = await horizon.loadAccount(recipient.publicKey());

  const recipientUsdcAfterUnits = assetBalanceUnits(recipientAfter, asset);
  const recipientXlmAfterUnits = nativeBalanceUnits(recipientAfter);
  const innerSignatureCount =
    transaction.inner_transaction?.signatures.length ??
    feeBump.innerTransaction.signatures.length;
  const outerSignatureCount = transaction.signatures.length;
  const verified = verifyPayoutEvidence({
    amountUnits,
    recipientUsdcBeforeUnits,
    recipientUsdcAfterUnits,
    recipientXlmBeforeUnits,
    recipientXlmAfterUnits,
    expectedFeeAccount: payoutPublicKey,
    feeAccount: transaction.fee_account,
    innerSignatureCount,
    outerSignatureCount,
  });

  const innerHash =
    transaction.inner_transaction?.hash ?? feeBump.innerTransaction.hash().toString("hex");
  log("");
  log("✅ E1-2 proof complete");
  log(
    JSON.stringify(
      {
        recipient: recipient.publicKey(),
        payoutAmountUsdc: unitsToUsdcString(amountUnits),
        recipientUsdcBefore: unitsToUsdcString(recipientUsdcBeforeUnits),
        recipientUsdcAfter: unitsToUsdcString(recipientUsdcAfterUnits),
        recipientUsdcIncrease: unitsToUsdcString(
          verified.recipientUsdcIncreaseUnits,
        ),
        recipientXlmBefore: unitsToUsdcString(recipientXlmBeforeUnits),
        recipientXlmAfter: unitsToUsdcString(recipientXlmAfterUnits),
        recipientXlmSpent: unitsToUsdcString(verified.recipientXlmSpentUnits),
        feeAccount: transaction.fee_account,
        feeChargedStroops: String(transaction.fee_charged),
        innerSignatureCount,
        outerSignatureCount,
        sponsorTransactionHash: sponsorHash,
        innerPaymentHash: innerHash,
        feeBumpTransactionHash: payoutHash,
        explorer: `${explorerUrl()}/tx/${payoutHash}`,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const response = (
    error as {
      response?: { data?: { extras?: unknown } };
    }
  )?.response?.data?.extras;
  console.error("MULTISIG PAYOUT SPIKE FAILED:", (error as Error)?.message ?? error);
  if (response) console.error(JSON.stringify(response, null, 2));
  process.exit(1);
});
