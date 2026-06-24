import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { payReward, PayoutCapError } from "./payout";
import { creditBalance, totalDebitWei } from "./campaign-balance";
import { checkAndAlert } from "./celo-balance";
import { computeIAA } from "./quality";
import { REWARDED_STATUSES } from "./constants";
import { refundReversal } from "./user-balance";

const STALE_PROCESSING_MS = 60_000;
// Refresh the in-flight job's heartbeat well within STALE_PROCESSING_MS so a slow
// payout (waitForTransactionReceipt alone can take up to 30s) is not mistaken for a
// stale job and reclaimed — and double-paid — by a second worker.
const HEARTBEAT_REFRESH_MS = 20_000;
const POLL_IDLE_MS = 5_000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 20;

let shouldStop = false;
let currentJobId: string | null = null;

export async function claimNextJob(): Promise<{
  id: string;
  submissionId: string | null;
  userId: string;
  amountWei: bigint;
  type: string;
} | null> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await prisma.$queryRaw<
    {
      id: string;
      submissionId: string | null;
      userId: string;
      amountWei: bigint;
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
    RETURNING "id", "submissionId", "userId", "amountWei", "type"
  `;

  if (claimed.length === 0) return null;
  return claimed[0];
}

async function refundCampaignBalance(
  task: { isGold: boolean; campaignId: string | null },
  submissionId: string,
  amountWei: bigint,
  reason: string,
): Promise<void> {
  if (task.isGold || !task.campaignId) return;
  await creditBalance(
    task.campaignId,
    totalDebitWei(amountWei),
    `${reason} for submission ${submissionId}`,
    "REFUND",
  ).catch(() => {});
}

async function processWithdrawalJob(
  jobId: string,
  userId: string,
  amountWei: bigint,
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
      await refundReversal(userId, amountWei, jobId, "Refund for missing destination").catch(() => {});
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
    const txHash = await payReward(destination as `0x${string}`, amountWei);

    await prisma.payoutJob.update({
      where: { id: jobId },
      data: {
        txHash,
        workerHeartbeatAt: new Date(),
      },
    });

    console.log(`[payout-worker] withdrawal job ${jobId} broadcast: paid ${amountWei} to ${destination} (${txHash})`);
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
      await refundReversal(userId, amountWei, jobId, "Refund for daily cap hit").catch(() => {});
      console.warn(`[payout-worker] withdrawal job ${jobId} failed: daily cap reached`);
      Sentry.captureMessage(`[payout-worker] withdrawal job ${jobId} daily cap hit: ${message}`, { level: "warning" });
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
      await refundReversal(userId, amountWei, jobId, `Refund for failed withdrawal: ${message}`).catch(() => {});
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
          campaign: { select: { defaultResponseTarget: true, rewardWei: true } },
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

  const walletAddress = submission.walletAddress as `0x${string}`;
  const amount = submission.payoutAmountWei;

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
          totalEarnedWei: { increment: amount },
          lastSubmissionAt: new Date(),
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

    const isNonceError =
      message.includes("nonce too low") ||
      message.includes("underpriced") ||
      message.includes("NONCE_");

    if (isNonceError) {
      // Nonce errors are usually transient, but a persistently nonce-erroring job
      // must still consume the retry budget — otherwise it requeues forever, never
      // marks the submission failed, and never alerts or triggers a refund.
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
            data: { status: "failed", completedAt: new Date(), lastError: `nonce error: ${message}`, retryCount: newRetryCount },
          }),
        ]);
        await refundCampaignBalance(submission.task, submissionId, amount, "refund: payout failed");
        console.error(`[payout-worker] submission job ${jobId} failed permanently after ${MAX_RETRIES} nonce-error retries: ${message}`);
        Sentry.captureMessage(`[payout-worker] submission job ${jobId} failed permanently (nonce): ${message}`, { level: "error" });
      } else {
        await prisma.payoutJob.update({
          where: { id: jobId },
          data: { status: "queued", workerHeartbeatAt: null, lastError: `nonce error, will retry: ${message}`, retryCount: newRetryCount },
        });
        console.warn(`[payout-worker] submission job ${jobId} nonce error, requeued (retry ${newRetryCount}/${MAX_RETRIES}): ${message}`);
      }
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
  amountWei: bigint,
  type: string,
): Promise<void> {
  currentJobId = jobId;

  if (type === "SUBMISSION_PAYOUT" && submissionId) {
    await processSubmissionPayout(jobId, submissionId);
  } else if (type === "WITHDRAWAL" && !submissionId) {
    await processWithdrawalJob(jobId, userId, amountWei);
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
      await processJob(claimed.id, claimed.submissionId, claimed.userId, claimed.amountWei, claimed.type);
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
