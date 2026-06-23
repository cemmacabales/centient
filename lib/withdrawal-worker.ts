import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { payReward, PayoutCapError, waitForTx } from "./payout";
import { redis } from "./redis";

const STALE_PROCESSING_MS = 30_000;
const POLL_IDLE_MS = 5_000;
const MAX_RETRIES = 3;
const HEARTBEAT_REFRESH_MS = 20_000;

let shouldStop = false;
let currentWithdrawalId: string | null = null;

async function claimNextWithdrawal(): Promise<{ id: string; txHash: string | null } | null> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await prisma.$queryRaw<{ id: string; txHash: string | null }[]>`
    UPDATE "user_withdrawals"
    SET "status" = 'processing',
        "startedAt" = COALESCE("startedAt", NOW()),
        "workerHeartbeatAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "id" = (
      SELECT "id" FROM "user_withdrawals"
      WHERE "status" = 'queued'
         OR ("status" = 'processing' AND "workerHeartbeatAt" < ${staleBefore})
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "txHash"
  `;

  if (claimed.length === 0) return null;

  const first = claimed[0];
  return { id: first.id, txHash: first.txHash };
}

async function confirmWithdrawal(id: string, txHash: string): Promise<void> {
  try {
    const receipt = await waitForTx(txHash as `0x${string}`);

    if (receipt.status === "success") {
      await prisma.userWithdrawal.update({
        where: { id },
        data: { status: "confirmed", completedAt: new Date() },
      });
      console.log(`[withdrawal-worker] confirmed withdrawal ${id}`);
    } else {
      await handleWithdrawalRetry(id, `reverted: status=${receipt.status}`);
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const isTimeout =
      message.includes("timed out") ||
      message.includes("timeout") ||
      message.includes("request");

    if (isTimeout) {
      await handleWithdrawalRetry(id, `timeout after ${STALE_PROCESSING_MS / 1000}s`);
    } else {
      await handleWithdrawalRetry(id, message);
    }
  }
}

async function handleWithdrawalRetry(id: string, reason: string): Promise<void> {
  const withdrawal = await prisma.userWithdrawal.findUnique({ where: { id } });
  if (!withdrawal) return;

  const newRetryCount = (withdrawal.retryCount ?? 0) + 1;

  if (newRetryCount >= MAX_RETRIES) {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: withdrawal.userId },
        data: { pendingBalanceWei: withdrawal.amountWei },
      }),
      prisma.userWithdrawal.update({
        where: { id },
        data: {
          status: "failed",
          retryCount: newRetryCount,
          completedAt: new Date(),
          lastError: reason,
        },
      }),
      prisma.userBalanceLedger.create({
        data: {
          userId: withdrawal.userId,
          type: "REVERSAL",
          amountWei: withdrawal.amountWei,
          note: `Withdrawal failed after ${MAX_RETRIES} retries: ${reason}, balance restored`,
        },
      }),
    ]);
    console.warn(`[withdrawal-worker] withdrawal ${id} marked failed after ${MAX_RETRIES} retries: ${reason}`);
    Sentry.captureMessage(`[withdrawal-worker] withdrawal ${id} failed: ${reason}`, { level: "warning" });
  } else {
    await prisma.userWithdrawal.update({
      where: { id },
      data: {
        retryCount: newRetryCount,
        lastError: reason,
      },
    });
    console.log(`[withdrawal-worker] withdrawal ${id} retry ${newRetryCount}/${MAX_RETRIES}: ${reason}`);
  }
}

export async function runWithdrawalWorkerLoop(): Promise<void> {
  console.log("[withdrawal-worker] starting loop");

  while (!shouldStop) {
    try {
      const claimed = await claimNextWithdrawal();
      if (!claimed) {
        await sleep(POLL_IDLE_MS);
        continue;
      }

      currentWithdrawalId = claimed.id;

      if (claimed.txHash) {
        await confirmWithdrawal(claimed.id, claimed.txHash);
      } else {
        await processWithdrawalSend(claimed.id);
      }

      currentWithdrawalId = null;
    } catch (err) {
      console.error("[withdrawal-worker] loop error:", err);
      Sentry.captureException(err, { extra: { context: "withdrawal-worker-loop" } });
      await sleep(POLL_IDLE_MS);
    }
  }

  console.log("[withdrawal-worker] loop stopped");
}

async function processWithdrawalSend(id: string): Promise<void> {
  const withdrawal = await prisma.userWithdrawal.findUnique({
    where: { id },
    include: { user: true },
  });

  if (!withdrawal) return;

  const heartbeat = setInterval(() => {
    prisma.userWithdrawal
      .update({ where: { id }, data: { workerHeartbeatAt: new Date() } })
      .catch(() => {});
  }, HEARTBEAT_REFRESH_MS);

  try {
    const txHash = await payReward(
      withdrawal.user.walletAddress as `0x${string}`,
      withdrawal.amountWei,
    );

    await prisma.userWithdrawal.update({
      where: { id },
      data: { status: "sent", txHash },
    });

    console.log(`[withdrawal-worker] withdrawal ${id} sent: ${txHash}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof PayoutCapError) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: withdrawal.userId },
          data: { pendingBalanceWei: withdrawal.amountWei },
        }),
        prisma.userWithdrawal.update({
          where: { id },
          data: {
            status: "failed",
            completedAt: new Date(),
            lastError: `payout cap exceeded: ${message}`,
          },
        }),
        prisma.userBalanceLedger.create({
          data: {
            userId: withdrawal.userId,
            type: "REVERSAL",
            amountWei: withdrawal.amountWei,
            note: `Withdrawal failed: payout cap exceeded, balance restored`,
          },
        }),
      ]);
      console.warn(`[withdrawal-worker] withdrawal ${id} failed: payout cap reached`);
      return;
    }

    await handleWithdrawalRetry(id, message);
  } finally {
    clearInterval(heartbeat);
  }
}

export function stopWithdrawalWorker(): void {
  shouldStop = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installSignalHandlers() {
  const handler = (signal: string) => {
    console.log(`[withdrawal-worker] received ${signal}, finishing in-flight job then exiting`);
    shouldStop = true;
    if (currentWithdrawalId) {
      console.log(`[withdrawal-worker] in-flight withdrawal ${currentWithdrawalId} will be retried on next run`);
    }
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}

const isEntrypoint = require.main === module;
if (isEntrypoint) {
  installSignalHandlers();
  runWithdrawalWorkerLoop().catch((err) => {
    console.error("[withdrawal-worker] fatal:", err);
    Sentry.captureException(err, { extra: { context: "withdrawal-worker-fatal" } });
    process.exit(1);
  });
}