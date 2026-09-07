import "dotenv/config";
import {
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  explorerUrl,
  networkPassphrase,
  server,
  stellarNetwork,
  usdcAsset,
} from "../lib/stellar/config";
import {
  buildSetOptionsTx,
  type AccountLike,
} from "../lib/stellar/multisig";
import {
  assertColdReserveMultisig,
  evaluateColdReserveSetupState,
  resolveColdReserveSetupKeys,
} from "../lib/stellar/cold-reserve-setup";

const FRIENDBOT_URL = "https://friendbot.stellar.org";
/** Emit operator-visible setup evidence without persisting it. */
const log = (...values: unknown[]) => console.log(...values);

/** Return whether Horizon currently exposes the requested account. */
async function accountExists(accountId: string): Promise<boolean> {
  try {
    await server().loadAccount(accountId);
    return true;
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status === 404) {
      return false;
    }
    throw error;
  }
}

/** Fund one absent testnet account, tolerating an already-funded race. */
async function friendbotFund(accountId: string): Promise<void> {
  const response = await fetch(
    `${FRIENDBOT_URL}?addr=${encodeURIComponent(accountId)}`,
  );
  if (!response.ok && !(response.status === 400 && (await accountExists(accountId)))) {
    throw new Error(`friendbot funding failed with HTTP ${response.status}`);
  }
}

/** Log an exact transaction hash, submit once, and verify Horizon's hash. */
async function submitOnce(transaction: Transaction, label: string) {
  const hash = transaction.hash().toString("hex");
  log(`${label} hash: ${hash}`);
  log(`${label} explorer: ${explorerUrl()}/tx/${hash}`);
  const result = await server().submitTransaction(transaction);
  if (result.hash !== hash) {
    throw new Error(
      `${label} returned a different hash; signed=${hash} returned=${result.hash}`,
    );
  }
  return hash;
}

/** Create the configured USDC trustline before multisig thresholds are raised. */
async function ensureUsdcTrustline(master: Keypair): Promise<void> {
  const horizon = server();
  const asset = usdcAsset();
  const account = await horizon.loadAccount(master.publicKey());
  const hasTrustline = account.balances.some(
    (balance) =>
      balance.asset_type !== "native" &&
      "asset_code" in balance &&
      balance.asset_code === asset.getCode() &&
      balance.asset_issuer === asset.getIssuer(),
  );
  if (hasTrustline) return;

  const transaction = new TransactionBuilder(account, {
    fee: String(await horizon.fetchBaseFee()),
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();
  transaction.sign(master);
  await submitOnce(transaction, "trustline");
}

/** Provision or verify the configured cold reserve without weakening custody. */
async function main() {
  const network = stellarNetwork();
  const { master, opsPublic, policyPublic } = resolveColdReserveSetupKeys({
    env: process.env,
    network,
    log,
  });

  log(`network: ${network}`);
  log(`cold account: ${master.publicKey()}`);
  log(`ops signer: ${opsPublic}`);
  log(`policy signer: ${policyPublic}`);

  if (!(await accountExists(master.publicKey()))) {
    if (network !== "testnet") {
      throw new Error(
        `cold account ${master.publicKey()} must be funded before public-network setup`,
      );
    }
    log("funding cold account through friendbot");
    await friendbotFund(master.publicKey());
  }

  const initialAccount = await server().loadAccount(master.publicKey());
  evaluateColdReserveSetupState(initialAccount as unknown as AccountLike, {
    masterPublic: master.publicKey(),
    opsPublic,
    policyPublic,
  });

  await ensureUsdcTrustline(master);
  const account = await server().loadAccount(master.publicKey());
  const current = evaluateColdReserveSetupState(
    account as unknown as AccountLike,
    {
      masterPublic: master.publicKey(),
      opsPublic,
      policyPublic,
    },
  );

  if (!current.matchesTarget) {
    const transaction = buildSetOptionsTx({
      account,
      masterKey: master,
      opsPublic,
      policyPublic,
    });
    transaction.sign(master);
    await submitOnce(transaction, "multisig setup");
  }

  const verified = await server().loadAccount(master.publicKey());
  assertColdReserveMultisig(verified as unknown as AccountLike, {
    masterPublic: master.publicKey(),
    opsPublic,
    policyPublic,
  });

  log("cold reserve verified: master/ops/policy weight 1, thresholds 2/2/2");
  log(`account explorer: ${explorerUrl()}/account/${master.publicKey()}`);
  log("next: fund this account with test USDC, then run the refill status command");
}

main().catch((error) => {
  console.error(
    "COLD RESERVE SETUP FAILED:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
