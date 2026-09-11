import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { payReward, PayoutCapError } from "./payout";
import { maybeSendCapAlert } from "./payout-cap";
import { StellarPaymentError, describeStellarError } from "./stellar/client";
import { creditBalance, totalDebitUnits } from "./campaign-balance";
import { checkAndAlert } from "./stellar/balance";
import { computeIAA } from "./quality";
import { REWARDED_STATUSES } from "./constants";
import { refundReversal } from "./user-balance";
import {
  abandonAcceptedPayment,
  persistAcceptedPayment,
  type AcceptedPayment,
} from "./payout-broadcast";

const STALE_PROCESSING_MS = 60_000;
// Refresh the in-flight job's heartbeat well within STALE_PROCESSING_MS so a slow
// payout (a Horizon submit can take several seconds for ledger inclusion) is not
// mistaken for a stale job and reclaimed — and double-paid — by a second worker.
const HEARTBEAT_REFRESH_MS = 20_000;
const POLL_IDLE_MS = 5_000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 20;

let shouldStop = false;
let currentJobId: string | null = null;

/**
 * True when a payout failed without establishing whether it settled on-chain.
 *
 * These are the only failures that must not be refunded. Every other
 * non-retryable code is a verdict that the payment never applied, so returning
 * the balance is correct; `ambiguous_submit` is the absence of a verdict, and
 * refunding one that did settle pays the user a second time — off-chain this
 * time. The job is failed and paged instead, for a human to reconcile against
 * the payout account before any reissue.
 */
function needsManualReconciliation(err: unknown): boolean {
  return err instanceof StellarPaymentError && err.code === "ambiguous_submit";
}

/**
 * Return a user's locked balance after a payout is abandoned, never throwing.
 *
 * A refund is the last step in an abandoned payout. If it throws (DB constraint,
 * ledger error) the funds are stranded with the job already marked failed or
 * completed, and there is no retry path. Swallowing that silently loses money
 * without a trace, so the failure is surfaced loudly to Sentry and the logs
 * instead of propagating and masking the original payout error.
 */

const RECONCILIATION_ERROR = "accepted payment needs manual reconciliation";

/**
 * Take a paid-but-unrecorded job out of the claimable set.
 *
 * `claimNextJob` reclaims any job still `processing` once its heartbeat goes
 * stale, so leaving it there would re-run the handler and pay a second time.
 * Failing it is not a refund: no refund path keys off this status, and the
 * reconciler only touches jobs that carry a hash.
 */
function quarantinePayoutJob(jobId: string): () => Promise<unknown> {
  return () =>
    prisma.payoutJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        completedAt: new Date(),
        lastError: RECONCILIATION_ERROR,
        retryCount: MAX_RETRIES,
      },
    });
}

/** Refund a failed withdrawal without letting the refund's own failure throw. */
async function safeRefund(
  userId: string,
  amountUnits: bigint,
  jobId: string,
  reason: string,
): Promise<void> {
  try {
    await refundReversal(userId, amountUnits, jobId, reason);
  } catch (refundErr) {
    console.error(`[payout-worker] CRITICAL: refund failed for job ${jobId} (${reason}):`, refundErr);
    Sentry.captureException(refundErr, {
      level: "error",
      extra: { context: "payout-refund-failure", jobId, userId, amountUnits: amountUnits.toString(), reason },
    });
  }
}

/**
 * Atomically claim the next queued payout job for this worker, or null when the
 * queue is empty. Claiming marks the job in-flight so a second worker cannot pick
 * up the same payout.
 */
export async function claimNextJob(): Promise<{
  id: string;
  submissionId: string | null;
  userId: string;
  amountUnits: bigint;
  type: string;
} | null> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await prisma.$queryRaw<
    {
      id: string;
      submissionId: string | null;
      userId: string;
      amountUnits: bigint;
      type: string;
    }[]
  >`
    UPDATE "payout_jobs"
    SET "status" = 'processing',
        "startedAt" = COALESCE("startedAt", NOW()),
        "workerHeartbeatAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "payout_jobs"
      WHERE "type" IN ('SUBMISSION_PAYOUT', 'WITHDRAWAL')
        AND ("status" = 'queued'
             OR ("status" = 'processing' AND "workerHeartbeatAt" < ${staleBefore}))
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "submissionId", "userId", "amountUnits", "type"
  `;

  if (claimed.length === 0) return null;
  return claimed[0];
}

/**
 * Credit an abandoned submission payout back to its campaign balance. Gold tasks
 * and campaign-less tasks draw from no campaign budget, so they are a no-op.
 * Best-effort: a failure here must not mask the payout error that triggered it.
 */
async function refundCampaignBalance(
  task: { isGold: boolean; campaignId: string | null },
  submissionId: string,
  amountUnits: bigint,
  reason: string,
): Promise<void> {
  if (task.isGold || !task.campaignId) return;
  await creditBalance(
    task.campaignId,
    totalDebitUnits(amountUnits),
    `${reason} for submission ${submissionId}`,
    "REFUND",
  ).catch(() => {});
}

/**
 * Settle one user-initiated withdrawal: resolve the destination, pay it, and on
 * failure classify the error, refund the user's locked balance, and either requeue
 * or fail the job permanently.
 */
/**
 * Settle one withdrawal: pay the destination, then record the broadcast tuple.
 * Once a hash exists the funds are gone, so a persistence failure pages for
 * reconciliation instead of refunding or requeueing.
 */
async function processWithdrawalJob(
  jobId: string,
  userId: string,
  amountUnits: bigint,
): Promise<void> {
  const job = await prisma.payoutJob.findUnique({
    where: { id: jobId },
  });
  if (!job) {
    console.error(`[payout-worker] withdrawal job ${jobId} not found`);
    await prisma.payoutJob.update({
      where: { id: jobId },
      data: { status: "failed", completedAt: new Date(), lastError: "job not found" },
    });
    return;
  }

  let destination: string | null = job.destinationAddress;
  if (!destination) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { walletAddress: true },
    });
    if (!user?.walletAddress) {
      console.error(`[payout-worker] user ${userId} has no walletAddress and no destinationAddress on job`);
      await prisma.payoutJob.update({
        where: { id: jobId },
        data: { status: "failed", completedAt: new Date(), lastError: "no destination address" },
      });
      await safeRefund(userId, amountUnits, jobId, "Refund for missing destination");
      return;
    }
    destination = user.walletAddress;
  }

  const heartbeat = setInterval(() => {
    prisma.payoutJob
      .update({ where: { id: jobId }, data: { workerHeartbeatAt: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_REFRESH_MS);

  let accepted: AcceptedPayment | undefined;
  try {
    const txHash = await payReward(destination, amountUnits, {
      kind: "payout_job",
      id: jobId,
    });
    const broadcastAt = new Date();
    accepted = { reference: `payout_job:${jobId}`, txHash, amountUnits, broadcastAt };

    const persisted = await persistAcceptedPayment(
      accepted,
      () =>
        prisma.payoutJob.update({
          where: { id: jobId },
          data: { txHash, amountUnits, broadcastAt, workerHeartbeatAt: broadcastAt },
        }),
      quarantinePayoutJob(jobId),
    );
    if (!persisted) return;

    // Only now can the alert read a rolling total that includes this payout: the
    // tuple it sums is the write that just landed. Fire-and-forget so a slow
    // Discord or Redis never delays a settled payout, and unawaited failures are
    // swallowed for the same reason — the payment already stands.
    maybeSendCapAlert().catch(() => {});

    console.log(`[payout-worker] withdrawal job ${jobId} broadcast: paid ${amountUnits} to ${destination} (${txHash})`);
  } catch (err) {
    if (accepted) {
      // The tuple may have persisted, but the job is still `processing` with a
      // dying heartbeat — quarantine it or a sweep re-pays it.
      await abandonAcceptedPayment(accepted, quarantinePayoutJob(jobId));
      return;
    }
    // F-04b: describe, don't stringify. A bare `err.message` from Horizon is
    // "Request failed with status code 400" and loses the result codes that say
    // *why*, which is the difference between an actionable failure and a mystery.
    const message = describeStellarError(err);

    if (err instanceof PayoutCapError) {
      await prisma.$transaction([
        prisma.payoutJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: `payout cap exceeded: ${message}`,
            retryCount: MAX_RETRIES,
          },
        }),
      ]);
      await safeRefund(userId, amountUnits, jobId, "Refund for daily cap hit");
      console.warn(`[payout-worker] withdrawal job ${jobId} failed: daily cap reached`);
      Sentry.captureMessage(`[payout-worker] withdrawal job ${jobId} daily cap hit: ${message}`, { level: "warning" });
      return;
    }

    // Non-retryable rail errors (`op_no_trust` — recipient `G…` holds no USDC
    // trustline; `op_no_destination` — recipient unfunded) can never succeed on a
    // blind retry. Fail the job immediately and refund the user's balance so they
    // can re-withdraw once they establish a trustline (ST-4b/ST-4e). Re-queueing
    // here would loop until MAX_RETRIES and waste cap/Horizon calls. A single
    // `tx_bad_seq` is rebuilt and resubmitted once inside the multisig submitter;
    // only sustained contention surfaces here, and it is retryable.
    //
    // `ambiguous_submit` is the one exception to the refund: it means the payout
    // may already have settled on-chain, so returning the balance too would pay
    // twice. See `needsManualReconciliation`.
    if (err instanceof StellarPaymentError && !err.retryable) {
      const unreconciled = needsManualReconciliation(err);
      await prisma.payoutJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          completedAt: new Date(),
          lastError: unreconciled
            ? `needs manual reconciliation (${err.code}): ${message}`
            : `non-retryable (${err.code}): ${message}`,
          retryCount: MAX_RETRIES,
        },
      });
      if (unreconciled) {
        console.error(`[payout-worker] withdrawal job ${jobId} needs manual reconciliation (${err.code}); balance NOT refunded: ${message}`);
        Sentry.captureMessage(`[payout-worker] withdrawal job ${jobId} needs manual reconciliation (${err.code}): ${message}`, { level: "error" });
        return;
      }
      await safeRefund(userId, amountUnits, jobId, `Refund for non-retryable payout (${err.code})`);
      console.warn(`[payout-worker] withdrawal job ${jobId} failed non-retryably (${err.code}): ${message}`);
      Sentry.captureMessage(`[payout-worker] withdrawal job ${jobId} non-retryable (${err.code}): ${message}`, { level: "warning" });
      return;
    }

    const jobRecord = await prisma.payoutJob.findUnique({ where: { id: jobId } });
    const newRetryCount = (jobRecord?.retryCount ?? 0) + 1;

    if (newRetryCount >= MAX_RETRIES) {
      await prisma.$transaction([
        prisma.payoutJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: message,
            retryCount: newRetryCount,
          },
        }),
      ]);
      await safeRefund(userId, amountUnits, jobId, `Refund for failed withdrawal: ${message}`);
      console.error(`[payout-worker] withdrawal job ${jobId} failed permanently after ${MAX_RETRIES} retries: ${message}`);
      Sentry.captureMessage(`[payout-worker] withdrawal job ${jobId} permanently failed: ${message}`, { level: "error" });
    } else {
      await prisma.payoutJob.update({
        where: { id: jobId },
        data: {
          status: "queued",
          workerHeartbeatAt: null,
          lastError: message,
          retryCount: newRetryCount,
        },
      });
      console.warn(`[payout-worker] withdrawal job ${jobId} retry ${newRetryCount}/${MAX_RETRIES}: ${message}`);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Settle one submission reward: pay the linked wallet, record the broadcast
 * tuple, then credit the submission and user bookkeeping. The tuple is persisted
 * before the bookkeeping so a bookkeeping failure cannot unwind a paid reward.
 */
async function processSubmissionPayout(
  jobId: string,
  submissionId: string,
): Promise<void> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      task: {
        include: {
          campaign: { select: { defaultResponseTarget: true, rewardUnits: true } },
        },
      },
    },
  });

  if (!submission) {
    console.error(`[payout-worker] submission ${submissionId} not found`);
    await prisma.payoutJob.update({
      where: { id: jobId },
      data: { status: "failed", completedAt: new Date(), lastError: "submission not found" },
    });
    return;
  }

  if (submission.payoutStatus !== "pending") {
    console.warn(`[payout-worker] submission ${submissionId} unexpected status: ${submission.payoutStatus}`);
    await prisma.payoutJob.update({
      where: { id: jobId },
      data: { status: "done", completedAt: new Date() },
    });
    return;
  }

  const walletAddress = submission.walletAddress;
  const amount = submission.payoutAmountUnits;

  // A submission with no linked wallet (email-only answerer, ST-5d) has no on-chain
  // destination. New earnings accrue off-chain and are never enqueued here, so this
  // legacy per-submission path only meets a wallet-less row defensively — fail it
  // rather than attempt an unpayable transfer.
  if (!walletAddress) {
    await prisma.$transaction([
      prisma.submission.update({
        where: { id: submissionId },
        data: { payoutStatus: "failed", payoutError: "no linked wallet", retryCount: MAX_RETRIES },
      }),
      prisma.payoutJob.update({
        where: { id: jobId },
        data: { status: "failed", completedAt: new Date(), lastError: "submission has no linked wallet", retryCount: MAX_RETRIES },
      }),
    ]);
    return;
  }

  const heartbeat = setInterval(() => {
    prisma.payoutJob
      .update({ where: { id: jobId }, data: { workerHeartbeatAt: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_REFRESH_MS);

  let accepted: AcceptedPayment | undefined;
  try {
    const txHash = await payReward(walletAddress, amount, {
      kind: "submission",
      id: submissionId,
    });
    const broadcastAt = new Date();
    accepted = { reference: `payout_job:${jobId}`, txHash, amountUnits: amount, broadcastAt };

    // The job's tuple and the submission's hash land in one write. The retry cron
    // re-broadcasts any `pending` submission without a hash, so writing the hash
    // in the bookkeeping transaction below would let a bookkeeping failure roll
    // it back and re-pay a settled payment (#73).
    //
    // If that write itself never lands, the quarantine has to cover both rows
    // for the same reason: failing only the job would still leave the
    // submission `pending` with no hash for the retry cron to find.
    const quarantine = () =>
      prisma.$transaction([
        prisma.submission.update({
          where: { id: submissionId },
          data: { payoutStatus: "needs_reconciliation", payoutTxHash: txHash },
        }),
        prisma.payoutJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: RECONCILIATION_ERROR,
            retryCount: MAX_RETRIES,
          },
        }),
      ]);
    const persisted = await persistAcceptedPayment(
      accepted,
      () =>
        prisma.$transaction([
          prisma.payoutJob.update({
            where: { id: jobId },
            data: { txHash, amountUnits: amount, broadcastAt, workerHeartbeatAt: broadcastAt },
          }),
          prisma.submission.update({
            where: { id: submissionId },
            data: { payoutStatus: "sent", payoutTxHash: txHash },
          }),
        ]),
      quarantine,
    );
    if (!persisted) return;

    // See the note in `processWithdrawalJob`: raised here rather than inside
    // `payReward` so the ledger the alert sums already carries this payout.
    maybeSendCapAlert().catch(() => {});

    await prisma.$transaction(async (tx) => {
      // Identity is the FK `userId` (ST-5d), not the wallet — the wallet is just the
      // on-chain destination validated above.
      await tx.user.update({
        where: { id: submission.userId },
        data: {
          submissionCount: { increment: 1 },
          totalEarnedUnits: { increment: amount },
          pendingBalanceUnits: { increment: amount },
          lastSubmissionAt: new Date(),
        },
      });

      await tx.userBalanceLedger.create({
        data: {
          userId: submission.userId,
          type: "CREDIT_REWARD",
          amountUnits: amount,
          submissionId: submissionId,
          note: `Reward for submission ${submissionId}`,
        },
      });
    });

    const task = submission.task;
    if (!task.isGold && task.responseTarget != null && !task.resolvedAt) {
      const paidCount = await prisma.submission.count({
        where: {
          taskId: submission.taskId,
          isGoldCheck: false,
          payoutStatus: { in: [...REWARDED_STATUSES] },
        },
      });
      if (paidCount >= task.responseTarget) {
        const iaa = await computeIAA(submission.taskId);
        if (iaa) {
          await prisma.task.update({
            where: { id: submission.taskId },
            data: {
              majorityAnswer: iaa.majorityAnswer,
              agreementScore: iaa.agreementScore,
              resolvedAt: new Date(),
            },
          });
        }
      }
    }

    await prisma.payoutJob.update({
      where: { id: jobId },
      data: { status: "done", completedAt: new Date(), workerHeartbeatAt: new Date() },
    });

    console.log(`[payout-worker] submission job ${jobId} completed: submission ${submissionId} paid ${txHash}`);
  } catch (err) {
    if (accepted) {
      // The tuple may have persisted, but the job is still `processing` with a
      // dying heartbeat — quarantine it or a sweep re-pays it.
      await abandonAcceptedPayment(accepted, quarantinePayoutJob(jobId));
      return;
    }
    // F-04b: same reasoning as the withdrawal path — keep Horizon's result codes.
    const message = describeStellarError(err);

    if (err instanceof PayoutCapError) {
      await prisma.$transaction([
        prisma.submission.update({
          where: { id: submissionId },
          data: { payoutStatus: "pending" },
        }),
        prisma.payoutJob.update({
          where: { id: jobId },
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: `payout cap exceeded: ${message}`,
          },
        }),
      ]);
      console.warn(`[payout-worker] submission job ${jobId} deferred: daily cap reached`);
      return;
    }

    // Non-retryable rail errors (`op_no_trust` / `op_no_destination`) can never
    // succeed on a blind retry — the recipient `G…` must add a USDC trustline /
    // be funded first. Fail immediately (consume the full retry budget) and refund
    // the campaign balance rather than requeue. A single `tx_bad_seq` is rebuilt
    // and resubmitted once inside the multisig submitter; only sustained
    // contention surfaces here, and it is retryable.
    //
    // `ambiguous_submit` is the one exception to the refund: it means the payout
    // may already have settled on-chain, so returning the balance too would pay
    // twice. See `needsManualReconciliation`.
    if (err instanceof StellarPaymentError && !err.retryable) {
      const unreconciled = needsManualReconciliation(err);
      const label = unreconciled
        ? `needs manual reconciliation (${err.code})`
        : `non-retryable (${err.code})`;
      await prisma.$transaction([
        prisma.submission.update({
          where: { id: submissionId },
          data: { payoutStatus: "failed", payoutError: label, retryCount: MAX_RETRIES },
        }),
        prisma.payoutJob.update({
          where: { id: jobId },
          data: { status: "failed", completedAt: new Date(), lastError: `${label}: ${message}`, retryCount: MAX_RETRIES },
        }),
      ]);
      if (unreconciled) {
        console.error(`[payout-worker] submission job ${jobId} needs manual reconciliation (${err.code}); campaign balance NOT refunded: ${message}`);
        Sentry.captureMessage(`[payout-worker] submission job ${jobId} needs manual reconciliation (${err.code}): ${message}`, { level: "error" });
        return;
      }
      await refundCampaignBalance(submission.task, submissionId, amount, `refund: non-retryable payout (${err.code})`);
      console.error(`[payout-worker] submission job ${jobId} failed non-retryably (${err.code}): ${message}`);
      Sentry.captureMessage(`[payout-worker] submission job ${jobId} non-retryable (${err.code}): ${message}`, { level: "warning" });
      return;
    }

    const job = await prisma.payoutJob.findUnique({ where: { id: jobId } });
    const newRetryCount = (job?.retryCount ?? 0) + 1;

    if (newRetryCount >= MAX_RETRIES) {
      await prisma.$transaction([
        prisma.submission.update({
          where: { id: submissionId },
          // F-04b: this branch used to set only the status, leaving payoutError
          // NULL — so the retry-exhausted failures an operator most needs to read
          // were the ones carrying no explanation at all.
          data: { payoutStatus: "failed", payoutError: `retries exhausted: ${message}` },
        }),
        prisma.payoutJob.update({
          where: { id: jobId },
          data: { status: "failed", completedAt: new Date(), lastError: message, retryCount: newRetryCount },
        }),
      ]);
      await refundCampaignBalance(submission.task, submissionId, amount, "refund: payout failed");
      console.error(`[payout-worker] submission job ${jobId} failed permanently after ${MAX_RETRIES} retries: ${message}`);
      Sentry.captureMessage(`[payout-worker] submission job ${jobId} failed permanently: ${message}`, { level: "error" });
    } else {
      await prisma.payoutJob.update({
        where: { id: jobId },
        data: { status: "queued", workerHeartbeatAt: null, lastError: message, retryCount: newRetryCount },
      });
      console.warn(`[payout-worker] submission job ${jobId} retry ${newRetryCount}/${MAX_RETRIES}: ${message}`);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** Dispatch one claimed job to its handler, failing jobs whose type and fields disagree. */
export async function processJob(
  jobId: string,
  submissionId: string | null,
  userId: string,
  amountUnits: bigint,
  type: string,
): Promise<void> {
  currentJobId = jobId;

  if (type === "SUBMISSION_PAYOUT" && submissionId) {
    await processSubmissionPayout(jobId, submissionId);
  } else if (type === "WITHDRAWAL" && !submissionId) {
    await processWithdrawalJob(jobId, userId, amountUnits);
  } else {
    console.error(`[payout-worker] job ${jobId} has invalid type/fields: type=${type}, submissionId=${submissionId}`);
    await prisma.payoutJob.update({
      where: { id: jobId },
      data: { status: "failed", completedAt: new Date(), lastError: "invalid job type or fields" },
    });
  }

  currentJobId = null;
}

/**
 * Claim and process payout jobs until {@link stopWorker} is called, idling on an
 * empty queue. A loop-level error is reported and slept off rather than killing
 * the worker, so one bad job cannot stop the rail.
 */
export async function runWorkerLoop(): Promise<void> {
  console.log("[payout-worker] starting loop");

  while (!shouldStop) {
    try {
      const claimed = await claimNextJob();
      if (!claimed) {
        await checkAndAlert();
        await sleep(POLL_IDLE_MS);
        continue;
      }
      await processJob(claimed.id, claimed.submissionId, claimed.userId, claimed.amountUnits, claimed.type);
    } catch (err) {
      console.error("[payout-worker] loop error:", err);
      Sentry.captureException(err, { extra: { context: "payout-worker-loop" } });
      await sleep(POLL_IDLE_MS);
    }
  }

  console.log("[payout-worker] loop stopped");
}

/** Ask the loop to exit after the in-flight job finishes. */
export function stopWorker(): void {
  shouldStop = true;
}

/** Resolve after `ms`, used for the idle-poll and error backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stop the loop cleanly on SIGINT/SIGTERM so an in-flight payout is not cut short. */
function installSignalHandlers() {
  const handler = (signal: string) => {
    console.log(`[payout-worker] received ${signal}, finishing in-flight job then exiting`);
    shouldStop = true;
    if (currentJobId) {
      console.log(`[payout-worker] in-flight job ${currentJobId} will be retried on next run`);
    }
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

const isEntrypoint = require.main === module;
if (isEntrypoint) {
  installSignalHandlers();
  runWorkerLoop().catch((err) => {
    console.error("[payout-worker] fatal:", err);
    Sentry.captureException(err, { extra: { context: "payout-worker-fatal" } });
    process.exit(1);
  });
}
