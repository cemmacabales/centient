import { REWARD_AMOUNT } from "./constants";
import { usdcToUnits } from "./stellar/config";
import { payUsdc, getTxStatus } from "./stellar/client";
import { checkPayoutCap, maybeSendCapAlert, PayoutCapError } from "./payout-cap";

export { PayoutCapError };

/**
 * Settle a single USDC payout from the pooled platform account to `to` (a `G…`
 * StrKey destination). Returns the Stellar transaction hash.
 *
 * Locking: the sequence-number mutex lives inside `stellar/client.payUsdc` (its
 * `seqMutex`), which is the single owner that serializes account-load + submit.
 * This function deliberately takes NO lock of its own — a second mutex here would
 * risk a deadlock and serialize the cap check needlessly without adding safety.
 *
 * Non-retryable `StellarPaymentError`s (`op_no_trust` — recipient holds no USDC
 * trustline; `op_no_destination` — recipient unfunded) propagate unchanged to the
 * caller, which must mark the payout failed rather than loop.
 */
export async function payReward(to: string, amountUnits?: bigint): Promise<string> {
  const amount = amountUnits ?? rewardInUnits();

  await checkPayoutCap(amount);

  const { hash } = await payUsdc(to, amount);

  maybeSendCapAlert().catch(() => {});

  return hash;
}

/**
 * Resolve a payout transaction to the coarse `{ status }` shape the reconciler
 * and reconcile-cron consume. Horizon-backed replacement for the old EVM receipt
 * poll: delegates to `stellar/client.getTxStatus`.
 *
 * A not-yet-visible transaction surfaces as a timeout-shaped error (rather than a
 * non-success status) so existing callers leave the payout as `sent` and retry
 * later — preserving the prior EVM-timeout behavior. ST-3b rewires those callers
 * to consume `getTxStatus` directly; this shim keeps them green in the meantime.
 */
export async function waitForTx(
  hash: string,
): Promise<{ status: "success" | "reverted"; transactionHash: string }> {
  const status = await getTxStatus(hash);
  if (status === "not_found") {
    throw new Error(
      `waitForTx: transaction ${hash} not yet confirmed on Horizon (timed out)`,
    );
  }
  return { status: status === "confirmed" ? "success" : "reverted", transactionHash: hash };
}

export function rewardInUnits(): bigint {
  return usdcToUnits(REWARD_AMOUNT);
}

export function resolveRewardUnits(
  taskRewardUnits: bigint | null,
  campaignRewardUnits: bigint | null,
): bigint {
  if (taskRewardUnits != null && taskRewardUnits > 0n) return taskRewardUnits;
  if (campaignRewardUnits != null && campaignRewardUnits > 0n) return campaignRewardUnits;
  return rewardInUnits();
}
