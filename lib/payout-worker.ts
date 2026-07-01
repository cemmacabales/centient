import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { payReward, PayoutCapError } from "./payout";
import { StellarPaymentError } from "./stellar/client";
import { creditBalance, totalDebitUnits } from "./campaign-balance";
import { checkAndAlert } from "./stellar/balance";
import { computeIAA } from "./quality";
import { REWARDED_STATUSES } from "./constants";
import { refundReversal } from "./user-balance";

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

// A refund is the last step that returns the user's locked balance after a payout
// is abandoned. If it throws (DB constraint, ledger error), the funds are stranded
// with the job already marked failed/completed — no retry path. Swallowing the error
// silently loses money without a trace, so surface it loudly to Sentry + logs.
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

  try {
    const txHash = await payReward(destination, amountUnits);

    await prisma.payoutJob.update({
      where: { id: jobId },
      data: {
        txHash,
        workerHeartbeatAt: new Date(),
      },
    });

    console.log(`[payout-worker] withdrawal job ${jobId} broadcast: paid ${amountUnits} to ${destination} (${txHash})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

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
    // here would loop until MAX_RETRIES and waste cap/Horizon calls. `tx_bad_seq`
    // is already retried once inside `payUsdc`, so it never reaches here.
    if (err instanceof StellarPaymentError && !err.retryable) {
      await prisma.payoutJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          completedAt: new Date(),
          lastError: `non-retryable (${err.code}): ${message}`,
          retryCount: MAX_RETRIES,
        },
      });
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

  const heartbeat = setInterval(() => {
    prisma.payoutJob
      .update({ where: { id: jobId }, data: { workerHeartbeatAt: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_REFRESH_MS);

  try {
    const txHash = await payReward(walletAddress, amount);

    await prisma.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submissionId },
        data: { payoutStatus: "sent", payoutTxHash: txHash },
      });

      await tx.user.update({
        where: { walletAddress: submission.walletAddress },
        data: {
          submissionCount: { increment: 1 },
          totalEarnedUnits: { increment: amount },
          pendingBalanceUnits: { increment: amount },
          lastSubmissionAt: new Date(),
        },
      });

      const user = await tx.user.findUnique({
        where: { walletAddress: submission.walletAddress },
        select: { id: true },
      });

      if (!user) {
        throw new Error(`No user found for walletAddress ${submission.walletAddress} — rolling back payout`);
      }

      await tx.userBalanceLedger.create({
        data: {
          userId: user.id,
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
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof PayoutCapError) {
      await prisma.$transaction([
        prisma.submission.update({
          where: { id: submissionId },
          data: { payoutStatus: "skipped" },
        }),
        prisma.payoutJob.update({
          where: { id: jobId },
          data: { status: "failed", completedAt: new Date(), lastError: `payout cap exceeded: ${message}`, retryCount: MAX_RETRIES },
        }),
      ]);
      await refundCampaignBalance(submission.task, submissionId, amount, "refund: payout cap reached");
      console.warn(`[payout-worker] submission job ${jobId} failed: daily cap reached`);
      return;
    }

    // Non-retryable rail errors (`op_no_trust` / `op_no_destination`) can never
    // succeed on a blind retry — the recipient `G…` must add a USDC trustline /
    // be funded first. Fail immediately (consume the full retry budget) and refund
    // the campaign balance rather than requeue. `tx_bad_seq` is retried once inside
    // `payUsdc`, so it never surfaces here.
    if (err instanceof StellarPaymentError && !err.retryable) {
      await prisma.$transaction([
        prisma.submission.update({
          where: { id: submissionId },
          data: { payoutStatus: "failed", payoutError: `non-retryable (${err.code})`, retryCount: MAX_RETRIES },
        }),
        prisma.payoutJob.update({
          where: { id: jobId },
          data: { status: "failed", completedAt: new Date(), lastError: `non-retryable (${err.code}): ${message}`, retryCount: MAX_RETRIES },
        }),
      ]);
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
          data: { payoutStatus: "failed" },
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

export function stopWorker(): void {
  shouldStop = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
