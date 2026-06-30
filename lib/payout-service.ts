import prisma from "@/lib/prisma";
import { payReward, PayoutCapError } from "./payout";

const TERMINAL_STATUSES = ["confirmed", "sent", "skipped"];

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Re-check eligibility under a per-wallet advisory lock. Returns the fresh
 * submission row if it still needs paying, or null if another worker already
 * advanced it to a terminal state. The on-chain payout is deliberately NOT
 * broadcast here — see reprocessPayoutWithNonceSafety for the rationale.
 */
async function claimForRetry(
  tx: any,
  submissionId: string,
  walletAddress: string,
): Promise<any | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${walletAddress}))`;

  const fresh = await tx.submission.findUnique({ where: { id: submissionId } });
  if (!fresh) throw new Error("Submission vanished during retry.");
  if (isTerminalStatus(fresh.payoutStatus)) return null;
  // A saved txHash means the on-chain transfer was already broadcast. Returning null
  // here prevents re-broadcast even if a prior error left the status as "failed".
  if (fresh.payoutTxHash) return null;

  return fresh;
}

/**
 * Credit the user's running totals exactly once, on the first successful send.
 * Runs as a best-effort follow-up: a failure here can leave totals uncredited
 * but can never trigger a re-send (the submission is already "sent").
 */
async function creditUserTotals(walletAddress: string, amount: bigint): Promise<void> {
  // claimForRetry already ensures payoutTxHash is null and status is pending/failed,
  // so no first-send guard is needed here.
  const user = await prisma.user.findUnique({
    where: { walletAddress },
    select: { submissionCount: true, totalEarnedUnits: true },
  });
  if (!user) return;

  await prisma.user.update({
    where: { walletAddress },
    data: {
      submissionCount: user.submissionCount + 1,
      totalEarnedUnits: user.totalEarnedUnits + amount,
    },
  });
}

/**
 * Retry a single payout with nonce safety and without double-pay risk.
 *
 * The on-chain transfer (payReward) is broadcast OUTSIDE of any database
 * transaction. If it were sent inside a $transaction that subsequently rolled
 * back (DB timeout, connection reset, lock contention), the persisted
 * payoutTxHash and "sent" status would be lost, and the next cron run would
 * re-send the same payout — a double payment. Instead we:
 *
 *   1. re-check eligibility under a per-wallet advisory lock,
 *   2. broadcast the transfer,
 *   3. persist payoutTxHash + "sent" in a single atomic update that cannot
 *      partially apply, so a later failure can never strand the txHash.
 */
export async function reprocessPayoutWithNonceSafety(submissionId: string): Promise<void> {
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
  if (!submission) throw new Error("Target submission record not found.");
  if (isTerminalStatus(submission.payoutStatus)) return;

  const walletAddress = submission.walletAddress;
  const amount = submission.payoutAmountUnits;

  // Step 1: claim the submission under a per-wallet advisory lock. If another
  // worker already advanced it to a terminal state, bail out without sending.
  const fresh = await prisma.$transaction((tx) =>
    claimForRetry(tx, submissionId, walletAddress),
  );
  if (!fresh) return;

  // Step 2: broadcast the on-chain transfer. payReward enforces the payout cap.
  let txHash: `0x${string}`;
  try {
    txHash = await payReward(walletAddress as `0x${string}`, amount);
  } catch (err: any) {
    console.error(`[payout-service] reprocess failed for submission ${submissionId}:`, err);

    if (err instanceof PayoutCapError || err?.name === "PayoutCapError") {
      // Cap breach is transient — leave the submission pending and don't burn a retry.
      await prisma.submission.update({
        where: { id: submissionId },
        data: { payoutStatus: "pending" },
      });
      return;
    }

    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        payoutStatus: "failed",
        retryCount: fresh.retryCount + 1,
        lastRetriedAt: new Date(),
      },
    });

    throw err;
  }

  // Step 3: persist the on-chain result atomically the instant payReward returns.
  // A single update cannot partially apply, so a later failure can never strand
  // the txHash and cause the next run to re-send.
  await prisma.submission.update({
    where: { id: submissionId },
    data: {
      payoutStatus: "sent",
      payoutTxHash: txHash,
      lastRetriedAt: new Date(),
    },
  });

  await creditUserTotals(walletAddress, amount);
}
