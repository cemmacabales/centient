import "dotenv/config";
import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  addReserveRefillSignature,
  buildReserveRefillTransaction,
  loadReserveRefillStatus,
  parseReserveRefillPolicy,
  parseReserveRefillExpectedAmountUnits,
  submitReserveRefill,
  validateReserveRefillTransaction,
  type ReserveRefillPlan,
} from "../lib/stellar/reserve-refill";
import {
  explorerUrl,
  networkPassphrase,
  server,
  unitsToUsdcString,
  usdcAsset,
} from "../lib/stellar/config";

/** Emit operator-visible refill status and transaction evidence. */
const log = (...values: unknown[]) => console.log(...values);

/** Render an exact refill plan as human-readable JSON without bigint loss. */
function serializePlan(plan: ReserveRefillPlan): string {
  return JSON.stringify(
    plan,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

/** Require a plan that can restore the target without crossing the cold floor. */
function requireActionable(plan: ReserveRefillPlan) {
  if (plan.status !== "refill_required") {
    throw new Error(
      `reserve refill is not actionable; current status is ${plan.status}`,
    );
  }
  return plan;
}

/** Read the unsigned or partially signed refill envelope from the environment. */
function requireXdr(): string {
  const xdr = process.env.STELLAR_RESERVE_REFILL_XDR?.trim();
  if (!xdr) {
    throw new Error("STELLAR_RESERVE_REFILL_XDR is required");
  }
  return xdr;
}

/** Execute one status, prepare, offline-sign, or submit operator command. */
async function main() {
  const command = process.argv[2] ?? "status";
  const policy = parseReserveRefillPolicy();
  const asset = usdcAsset();

  if (!["status", "prepare", "sign", "submit"].includes(command)) {
    throw new Error(
      `unknown reserve refill command "${command}"; use status, prepare, sign, or submit`,
    );
  }

  if (command === "sign") {
    const expectedAmountUnits = parseReserveRefillExpectedAmountUnits();
    const decoded = TransactionBuilder.fromXDR(
      requireXdr(),
      networkPassphrase(),
    );
    if (decoded instanceof FeeBumpTransaction) {
      throw new Error("reserve refill must not use a fee-bump envelope");
    }
    validateReserveRefillTransaction({
      transaction: decoded,
      policy,
      asset,
      expectedAmountUnits,
      nowSeconds: Math.floor(Date.now() / 1000),
      requireSignatures: false,
    });
    const secret = process.env.STELLAR_COLD_SIGNER_SECRET?.trim();
    if (!secret) throw new Error("STELLAR_COLD_SIGNER_SECRET is required");
    let signer: Keypair;
    try {
      signer = Keypair.fromSecret(secret);
    } catch {
      throw new Error("STELLAR_COLD_SIGNER_SECRET is not a valid Stellar seed");
    }
    addReserveRefillSignature(decoded, signer, policy);
    log(`signed by: ${signer.publicKey()}`);
    log(`signature count: ${decoded.signatures.length}`);
    log(`STELLAR_RESERVE_REFILL_XDR=${decoded.toXDR()}`);
    return;
  }

  if (command === "status") {
    const plan = await loadReserveRefillStatus({ asset });
    log(serializePlan(plan));
    return;
  }

  if (command === "prepare") {
    const actionable = requireActionable(
      await loadReserveRefillStatus({ asset }),
    );
    const horizon = server();
    const [coldAccount, baseFee] = await Promise.all([
      horizon.loadAccount(policy.coldAccount),
      horizon.fetchBaseFee(),
    ]);
    const transaction = buildReserveRefillTransaction({
      sourceAccount: coldAccount,
      policy,
      asset,
      amountUnits: actionable.amountUnits,
      fee: String(baseFee),
    });
    validateReserveRefillTransaction({
      transaction,
      policy,
      asset,
      expectedAmountUnits: actionable.amountUnits,
      nowSeconds: Math.floor(Date.now() / 1000),
      requireSignatures: false,
    });
    const hash = transaction.hash().toString("hex");
    log("status: refill_required");
    log(`amount: ${unitsToUsdcString(actionable.amountUnits)} USDC`);
    log(`cold: ${policy.coldAccount}`);
    log(`hot: ${policy.hotAccount}`);
    log(`hash: ${hash}`);
    log(`explorer: ${explorerUrl()}/tx/${hash}`);
    log(`STELLAR_RESERVE_REFILL_XDR=${transaction.toXDR()}`);
    return;
  }

  if (command === "submit") {
    // Re-read balances so the policy invariants are checked against the ledger
    // as it is now, not as it was at prepare time. The signed amount itself is
    // authoritative: payouts during the signing ceremony move the hot balance,
    // and re-deriving the amount here would reject the custodians' signatures.
    const plan = await loadReserveRefillStatus({ asset });
    const horizon = server();
    const result = await submitReserveRefill({
      signedXdr: requireXdr(),
      policy,
      asset,
      hotBalanceUnits: plan.hotBalanceUnits,
      coldBalanceUnits: plan.coldBalanceUnits,
      nowSeconds: Math.floor(Date.now() / 1000),
      log,
      submit: (transaction) => horizon.submitTransaction(transaction),
    });
    log(`submitted: ${result.hash}`);
    return;
  }
}

main().catch((error) => {
  console.error(
    "RESERVE REFILL FAILED:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
