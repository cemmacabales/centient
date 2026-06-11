import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { payReward, PayoutCapError } from "./payout";
import { checkAndAlert } from "./celo-balance";
import { computeIAA } from "./quality";

const STALE_PROCESSING_MS = 60_000;
const POLL_IDLE_MS = 5_000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 20;

let shouldStop = false;
let currentJobId: string | null = null;

async function claimNextJob(): Promise<{ id: string; submissionId: string } | null> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await prisma.$queryRaw<{ id: string; submissionId: string }[]>`
    UPDATE "payout_jobs"
    SET "status" = 'processing',
        "startedAt" = COALESCE("startedAt", NOW()),
        "workerHeartbeatAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "payout_jobs"
      WHERE "status" = 'queued'
         OR ("status" = 'processing' AND "workerHeartbeatAt" < ${staleBefore})
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "submissionId"
  `;

  if (claimed.length === 0) return null;

  const first = claimed[0];
  return { id: first.id, submissionId: first.submissionId };
}

async function processJob(jobId: string, submissionId: string): Promise<void> {
  currentJobId = jobId;

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
      data: {
        status: "failed",
        completedAt: new Date(),
        lastError: "submission not found",
      },
    });
    return;
  }

  if (submission.payoutStatus !== "pending") {
    console.warn(`[payout-worker] submission ${submissionId} has unexpected status: ${submission.payoutStatus}`);
    await prisma.payoutJob.update({
      where: { id: jobId },
      data: {
        status: "done",
        completedAt: new Date(),
      },
    });
    return;
  }

  const walletAddress = submission.walletAddress as `0x${string}`;
  const amount = submission.payoutAmountWei;

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
          payoutStatus: { in: ["sent", "confirmed"] },
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
      data: {
        status: "done",
        completedAt: new Date(),
        workerHeartbeatAt: new Date(),
      },
    });

    console.log(`[payout-worker] job ${jobId} completed: submission ${submissionId} paid ${txHash}`);
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
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: `payout cap exceeded: ${message}`,
            retryCount: MAX_RETRIES,
          },
        }),
      ]);
      console.warn(`[payout-worker] job ${jobId} failed: daily cap reached`);
      return;
    }

    const isNonceError =
      message.includes("nonce too low") ||
      message.includes("underpriced") ||
      message.includes("NONCE_");

    if (isNonceError) {
      await prisma.payoutJob.update({
        where: { id: jobId },
        data: {
          status: "queued",
          workerHeartbeatAt: null,
          lastError: `nonce error, will retry: ${message}`,
        },
      });
      console.warn(`[payout-worker] job ${jobId} nonce error, requeued: ${message}`);
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
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: message,
            retryCount: newRetryCount,
          },
        }),
      ]);
      console.error(`[payout-worker] job ${jobId} failed permanently after ${MAX_RETRIES} retries: ${message}`);
      Sentry.captureMessage(`[payout-worker] job ${jobId} failed permanently: ${message}`, { level: "error" });
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
      console.warn(`[payout-worker] job ${jobId} retry ${newRetryCount}/${MAX_RETRIES}: ${message}`);
    }
  } finally {
    currentJobId = null;
  }
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
      await processJob(claimed.id, claimed.submissionId);
    } catch (err) {
      console.error("[payout-worker] loop error:", err);
      Sentry.captureException(err, {
        extra: { context: "payout-worker-loop" },
      });
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
    Sentry.captureException(err, {
      extra: { context: "payout-worker-fatal" },
    });
    process.exit(1);
  });
}