import prisma from "@/lib/prisma";
import { payReward, PayoutCapError } from "./payout";
import { maybeSendCapAlert } from "./payout-cap";
import { StellarPaymentError } from "./stellar/client";
import { isValidStellarAddress } from "./stellar/signature";
import { abandonAcceptedPayment, persistAcceptedPayment } from "./payout-broadcast";

// `needs_reconciliation` marks a payment that settled on-chain but could not be
// recorded. It is terminal for retry purposes: a human must reconcile it against
// the payout account, and no automatic path may broadcast it again.
const TERMINAL_STATUSES = ["confirmed", "sent", "skipped", "needs_reconciliation"];

/** Is this payout status final — already paid, skipped, or confirmed — and so never re-sent? */
function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * How long a claimed retry is considered in flight. Sized to the retry cron's
 * shortest backoff (`BASE_BACKOFF_MS`, 60s at retryCount 0) so the lease and the
 * backoff are exactly complementary: the cron will not offer a `failed`
 * submission again until 60s have passed, and this refuses it for the same 60s.
 * A lease can therefore never delay a retry the cron considers due.
 */
const RETRY_CLAIM_LEASE_MS = 60_000;

/**
 * How often an in-flight retry refreshes its claim. Well inside
 * `RETRY_CLAIM_LEASE_MS`, for the reason the worker's own heartbeat exists: a
 * Horizon submit can take several seconds, and a lease that expires under a live
 * broadcast would let a second claimant broadcast before the first stores its
 * hash — the double-payment the lease is there to prevent.
 */
export const RETRY_CLAIM_HEARTBEAT_MS = 20_000;

/**
 * Claim a submission for one retry under a per-wallet advisory lock. Returns the
 * fresh row if it still needs paying, or null if it is terminal, already
 * broadcast, or held by another retry in flight. The on-chain payout is
 * deliberately NOT broadcast here — see reprocessPayoutWithNonceSafety.
 *
 * The lease is what makes the advisory lock mean anything. The lock is
 * transaction-scoped, and this function used only to *read*, so N callers
 * serialized by the lock each observed the identical pre-broadcast row, each
 * returned it, and each broadcast — the lock ordered the reads and prevented
 * nothing. `reprocessPayoutWithNonceSafety` is reachable concurrently in two
 * ways that make that a live double-payment: two retry-cron runs overlapping
 * (the `stuckPending` query filters on age, never on whether a retry is already
 * running), and an admin retry landing while the cron holds the same row.
 *
 * Writing `lastRetriedAt` inside the locked transaction is what a second
 * claimant observes. Same column, same lease idea, and the same
 * `STALE_PROCESSING_MS`-shaped reasoning the reconciler's `claimNextSubmission`
 * and the worker's `claimNextJob` already use for their own rows.
 *
 * A live retry refreshes the lease while it broadcasts (see
 * `heartbeatRetryClaim`), which is what keeps a slow submit from losing a claim
 * it still holds. It reduces that risk rather than eliminating it: refreshes are
 * best-effort writes whose failures are swallowed, and a stalled event loop
 * delays them, so a sufficiently degraded process can still have its lease
 * expire while its payout is in flight.
 *
 * Process death is the case it cannot help with at all — refreshes simply stop,
 * the lease expires, and the row is reclaimed without the envelope hash the
 * first attempt never got to persist. Closing either outright needs the hash
 * persisted *before* submit and reconciled before reissue: the same gap tracked
 * on the roadmap, and a payout state-machine change rather than a locking one.
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
  if (
    fresh.lastRetriedAt &&
    Date.now() - fresh.lastRetriedAt.getTime() < RETRY_CLAIM_LEASE_MS
  ) {
    return null;
  }

  // Taken before the lock is released, so the next claimant reads it and stands
  // down. Every later write of this column — success, failure, or the admin
  // route's reset — overwrites the lease, which is correct: each one is a newer
  // statement about the same retry.
  await tx.submission.update({
    where: { id: submissionId },
    data: { lastRetriedAt: new Date() },
  });

  return fresh;
}

/**
 * Keep a claimed retry's lease fresh for as long as its payout is in flight.
 *
 * `updateMany` with `payoutTxHash: null` rather than `update` by id, so the
 * refresh becomes a no-op the instant the broadcast tuple lands. That keeps a
 * heartbeat that fires between the persist and `clearInterval` from writing a
 * later `lastRetriedAt` over the recorded broadcast time.
 *
 * Failures are swallowed and never interrupt the payout: turning a bookkeeping
 * error into a payment error is backwards. The cost is that this is best-effort
 * — enough consecutive failed refreshes, or a long enough event-loop stall, and
 * the lease lapses under a live broadcast anyway. It narrows the window; it does
 * not fence the payout.
 */
function heartbeatRetryClaim(submissionId: string): NodeJS.Timeout {
  return setInterval(() => {
    prisma.submission
      .updateMany({
        where: { id: submissionId, payoutTxHash: null },
        data: { lastRetriedAt: new Date() },
      })
      .catch(() => {});
  }, RETRY_CLAIM_HEARTBEAT_MS);
}

/**
 * Credit the user's running totals exactly once, on the first successful send.
 * Runs as a best-effort follow-up: a failure here can leave totals uncredited
 * but can never trigger a re-send (the submission is already "sent").
 */
/** Credit a paid reward to the user's running totals. */
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
 *   3. persist payoutTxHash, "sent", and the PayoutJob accounting tuple in one
 *      transaction after the transfer has been accepted.
 */
/**
 * Legacy retry path for a stuck submission payout, guarded so a retry can never
 * double-pay: terminal states are skipped, and once a hash exists a persistence
 * failure pages for reconciliation rather than unwinding the payment.
 */
export async function reprocessPayoutWithNonceSafety(submissionId: string): Promise<void> {
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
  if (!submission) throw new Error("Target submission record not found.");
  if (isTerminalStatus(submission.payoutStatus)) return;

  const walletAddress = submission.walletAddress;
  const amount = submission.payoutAmountUnits;

  // Step 0: StrKey-validate the `G…` destination before doing any work. A missing
  // wallet (email-only answerer, ST-5d) or a malformed/non-StrKey address can never
  // be paid (the rail would fail with `op_no_destination`), so mark it failed
  // permanently rather than burning the retry budget on a guaranteed-to-fail payout.
  if (!walletAddress || !isValidStellarAddress(walletAddress)) {
    await prisma.submission.update({
      where: { id: submissionId },
      data: { payoutStatus: "failed", lastRetriedAt: new Date() },
    });
    throw new Error(
      `[payout-service] submission ${submissionId} has no payable Stellar address: ${walletAddress}`,
    );
  }

  // Step 1: claim the submission under a per-wallet advisory lock. If another
  // worker already advanced it to a terminal state, bail out without sending.
  const fresh = await prisma.$transaction((tx) =>
    claimForRetry(tx, submissionId, walletAddress),
  );
  if (!fresh) return;

  // The claim is a lease, and a lease that expires under a live broadcast is
  // no lease at all. Refresh it for exactly as long as this payout is in
  // flight — through the submit and through the write that records it.
  const heartbeat = heartbeatRetryClaim(submissionId);
  try {
    // Step 2: broadcast the on-chain transfer. payReward enforces the payout cap.
    // txHash is now a Stellar hash (plain string) — the full payout-service port to
    // `payUsdc`/`G…` destinations is ST-3d (#298); this widens the type to keep the
    // build green in the meantime.
    let txHash: string;
    try {
      txHash = await payReward(walletAddress, amount, {
        kind: "submission",
        id: submissionId,
      });
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

      // Non-retryable rail errors (`op_no_trust` — recipient holds no USDC
      // trustline; `op_no_destination` — recipient unfunded) can never succeed on
      // a blind retry. Surface the reason explicitly; the submission is marked
      // failed below and the cron retry job (ST-3b) must not auto-retry it.
      if (err instanceof StellarPaymentError && !err.retryable) {
        console.error(
          `[payout-service] submission ${submissionId} permanently failed (${err.code}): ${err.message}`,
        );
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

    // Step 3: persist the on-chain result and its accounting record atomically.
    const broadcastAt = new Date();
    const accepted = { reference: `submission:${submissionId}`, txHash, amountUnits: amount, broadcastAt };
    // Storing the hash is what makes this irreversible for the retry paths:
    // `claimForRetry` refuses any submission that already carries one, and the
    // status is terminal, so neither the cron nor an admin retry can re-broadcast.
    const quarantine = () =>
      prisma.submission.update({
        where: { id: submissionId },
        data: {
          payoutStatus: "needs_reconciliation",
          payoutTxHash: txHash,
          lastRetriedAt: new Date(),
        },
      });

    const persisted = await persistAcceptedPayment(accepted, () => prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: submissionId },
          data: { payoutStatus: "sent", payoutTxHash: txHash, lastRetriedAt: broadcastAt },
        });
        await tx.payoutJob.upsert({
          where: { submissionId },
          create: {
            type: "SUBMISSION_PAYOUT",
            submissionId,
            amountUnits: amount,
            txHash,
            broadcastAt,
            status: "done",
            completedAt: broadcastAt,
          },
          update: {
            amountUnits: amount,
            txHash,
            broadcastAt,
            status: "done",
            completedAt: broadcastAt,
            lastError: null,
          },
        });
    }), quarantine);
    if (!persisted) return;

    // Raised only once the broadcast tuple is in the ledger the alert reads. Doing
    // it inside `payReward` would sum a total that excludes this payout and could
    // skip the threshold crossing it just caused.
    maybeSendCapAlert().catch(() => {});

    try {
      await creditUserTotals(walletAddress, amount);
    } catch {
      // The payment and its hash are recorded; only the totals failed. The stored
      // hash already blocks re-broadcast, so this just needs a human.
      await abandonAcceptedPayment(accepted, quarantine);
    }
  } finally {
    clearInterval(heartbeat);
  }
}
