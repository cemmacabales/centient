import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { waitForTx } from "./payout";
import { checkAndAlert } from "./celo-balance";

const STALE_PROCESSING_MS = 30_000;
const POLL_IDLE_MS = 5_000;
const MAX_RETRIES = 3;
const BATCH_SIZE = 50;

let shouldStop = false;
let currentSubmissionId: string | null = null;

async function claimNextSubmission(): Promise<{ id: string; payoutTxHash: string } | null> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await prisma.submission.findMany({
    where: {
      payoutStatus: "sent",
      payoutTxHash: { not: null },
      OR: [
        { payoutLastCheckedAt: null },
        { payoutLastCheckedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { payoutLastCheckedAt: "asc" },
    take: BATCH_SIZE,
    select: { id: true, payoutTxHash: true },
  });

  if (claimed.length === 0) return null;

  const first = claimed[0];
  await prisma.submission.update({
    where: { id: first.id },
    data: { payoutLastCheckedAt: new Date() },
  });

  return { id: first.id, payoutTxHash: first.payoutTxHash! };
}

async function processSubmission(id: string, txHash: string): Promise<void> {
  currentSubmissionId = id;

  try {
    const receipt = await waitForTx(txHash as `0x${string}`);

    if (receipt.status === "success") {
      await prisma.submission.update({
        where: { id },
        data: { payoutStatus: "confirmed", payoutLastCheckedAt: new Date() },
      });
      console.log(`[reconciler] confirmed submission ${id}`);
    } else {
      await handleRetry(id, `reverted: status=${receipt.status}`);
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const isTimeout =
      message.includes("timed out") ||
      message.includes("timeout") ||
      message.includes("request");

    if (isTimeout) {
      await handleRetry(id, `timeout after ${STALE_PROCESSING_MS / 1000}s`);
    } else {
      await handleRetry(id, message);
    }
  } finally {
    currentSubmissionId = null;
  }
}

async function handleRetry(id: string, reason: string): Promise<void> {
  const sub = await prisma.submission.findUnique({ where: { id } });
  if (!sub) return;

  const newCount = (sub.payoutRetryCount ?? 0) + 1;

  if (newCount >= MAX_RETRIES) {
    await prisma.submission.update({
      where: { id },
      data: {
        payoutStatus: "failed",
        payoutRetryCount: newCount,
        payoutLastCheckedAt: new Date(),
      },
    });
    console.warn(`[reconciler] submission ${id} marked failed after ${MAX_RETRIES} retries: ${reason}`);
    Sentry.captureMessage(`[reconciler] submission ${id} failed: ${reason}`, { level: "warning" });
  } else {
    await prisma.submission.update({
      where: { id },
      data: {
        payoutRetryCount: newCount,
        payoutLastCheckedAt: new Date(),
      },
    });
    console.log(`[reconciler] submission ${id} retry ${newCount}/${MAX_RETRIES}: ${reason}`);
  }
}

export async function runReconcilerLoop(): Promise<void> {
  console.log("[reconciler] starting loop");

  while (!shouldStop) {
    try {
      const claimed = await claimNextSubmission();
      if (!claimed) {
        await checkAndAlert();
        await sleep(POLL_IDLE_MS);
        continue;
      }
      await processSubmission(claimed.id, claimed.payoutTxHash);
    } catch (err) {
      console.error("[reconciler] loop error:", err);
      Sentry.captureException(err, { extra: { context: "reconciler-loop" } });
      await sleep(POLL_IDLE_MS);
    }
  }

  console.log("[reconciler] loop stopped");
}

export function stopReconciler(): void {
  shouldStop = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installSignalHandlers() {
  const handler = (signal: string) => {
    console.log(`[reconciler] received ${signal}, finishing in-flight job then exiting`);
    shouldStop = true;
    if (currentSubmissionId) {
      console.log(`[reconciler] in-flight submission ${currentSubmissionId} will be retried on next run`);
    }
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

const isEntrypoint = require.main === module;
if (isEntrypoint) {
  installSignalHandlers();
  runReconcilerLoop().catch((err) => {
    console.error("[reconciler] fatal:", err);
    Sentry.captureException(err, { extra: { context: "reconciler-fatal" } });
    process.exit(1);
  });
}