import { capturePayoutTransaction } from "./payout-analytics";
import { REWARD_AMOUNT } from "./constants";
import { usdcToUnits } from "./stellar/config";
import { getTxStatus, StellarPaymentError } from "./stellar/client";
import { resolvePayoutCoSigner } from "./stellar/payout-cosigner";
import type { PayoutReference } from "./stellar/payout-envelope";
import { submitMultisigPayout } from "./stellar/payout-submitter";
import { submissionAttemptJournal } from "./payout-attempts";
import { checkPayoutCap, maybeSendCapAlert, PayoutCapError } from "./payout-cap";

export { PayoutCapError };

/**
 * Settle a single USDC payout from the multisig payout account to `to` (a `G…`
 * StrKey destination). Returns the Stellar transaction hash.
 *
 * Every payout settles as a two-signature, fee-bumped payment (E1-3 #7): the
 * service builds it, signs as the platform, hands the envelope to the independent
 * co-signer, and submits only once both signatures verify. The single-key
 * `stellar/client.payUsdc` broadcast is no longer on this path, and an
 * unconfigured co-signer throws here rather than degrading to one signature.
 *
 * `reference` names the ledger row being settled so the co-signer can re-derive
 * the amount independently instead of trusting ours (#8).
 *
 * Locking: the sequence-number mutex lives inside `submitMultisigPayout`, which
 * is the single owner that serializes account-load + submit for the payout
 * account. This function deliberately takes NO lock of its own — a second mutex
 * here would risk a deadlock and serialize the cap check needlessly without
 * adding safety.
 *
 * Non-retryable `StellarPaymentError`s (`op_no_trust` — recipient holds no USDC
 * trustline; `op_no_destination` — recipient unfunded) propagate unchanged to the
 * caller, which must mark the payout failed rather than loop.
 *
 * Cap alerting on the success path deliberately does NOT happen here. This
 * function returns before any caller has written the broadcast tuple, so an
 * alert raised from here reads a rolling total that excludes the payout that
 * just settled and can skip a threshold crossing entirely. Each caller raises it
 * instead, immediately after `persistAcceptedPayment` succeeds, where the ledger
 * the alert reads already contains the payout. Passing the amount in from here
 * is not the fix: the read may or may not already see the tuple, so it trades a
 * missed alert for a double-count. Only the rejection path below keeps an
 * argument, because nothing records a refused payout.
 */
export async function payReward(
  to: string,
  amountUnits: bigint | undefined,
  reference: PayoutReference,
): Promise<string> {
  const amount = amountUnits ?? rewardInUnits();

  try {
    await checkPayoutCap(amount);
  } catch (err) {
    if (err instanceof PayoutCapError) {
      maybeSendCapAlert(amount).catch(() => {});
    }
    throw err;
  }

  // Resolved before submission so a missing co-signer fails the payout outright
  // rather than after an envelope has been built and a sequence number spent.
  const coSigner = resolvePayoutCoSigner();

  let hash: string;
  try {
    ({ hash } = await submitMultisigPayout(
      { destination: to, amountUnits: amount, reference },
      {
        coSigner,
        // #38: every submission payout records its envelope before submit, so no
        // caller can forget to. Withdrawals are retired by #39 and not journalled.
        ...(reference.kind === "submission" ? { attempts: submissionAttemptJournal(reference.id) } : {}),
      },
    ));
  } catch (err) {
    capturePayoutTransaction({
      walletAddress: to,
      amountUnits: amount,
      reference,
      txHash: txHashFromError(err),
      success: false,
      errorCode: err instanceof StellarPaymentError ? err.code : "unknown",
    });
    throw err;
  }

  capturePayoutTransaction({ walletAddress: to, amountUnits: amount, reference, txHash: hash, success: true });
  return hash;
}

/**
 * The envelope hash a failed submit names, when it names one. The submitter
 * knows the hash before submitting and puts it in the message of an included-
 * and-failed or ambiguous outcome; a rejection before submit has none.
 */
function txHashFromError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : "";
  return message.match(/\b[0-9a-f]{64}\b/)?.[0] ?? null;
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

/** The default per-submission reward, in exact integer units. */
export function rewardInUnits(): bigint {
  return usdcToUnits(REWARD_AMOUNT);
}

/**
 * The reward a submission actually earns: the task's own amount when set, else the
 * campaign's, else the platform default. Zero and null are treated as unset so a
 * missing override can never silently pay nothing.
 */
export function resolveRewardUnits(
  taskRewardUnits: bigint | null,
  campaignRewardUnits: bigint | null,
): bigint {
  if (taskRewardUnits != null && taskRewardUnits > 0n) return taskRewardUnits;
  if (campaignRewardUnits != null && campaignRewardUnits > 0n) return campaignRewardUnits;
  return rewardInUnits();
}
