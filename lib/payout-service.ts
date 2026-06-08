import prisma from "@/lib/prisma";
import { payReward, PayoutCapError } from "./payout";

async function reprocessCore(
  tx: any,
  submissionId: string,
  walletAddress: string,
  amount: bigint,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${walletAddress}))`;

  const fresh = await tx.submission.findUnique({ where: { id: submissionId } });
  if (!fresh) throw new Error("Submission vanished during retry.");
  if (fresh.payoutStatus === "confirmed" || fresh.payoutStatus === "sent" || fresh.payoutStatus === "skipped") {
    return;
  }

  try {
    const txHash = await payReward(walletAddress as `0x${string}`, amount);

    const wasPending = fresh.payoutStatus === "pending";
    const wasAlreadySent = fresh.payoutTxHash != null;
    const shouldUpdateTotals = (wasPending || fresh.payoutStatus === "failed") && !wasAlreadySent;

    await tx.submission.update({
      where: { id: submissionId },
      data: {
        payoutStatus: "sent",
        payoutTxHash: txHash,
        lastRetriedAt: new Date(),
      },
    });

    const user = await tx.user.findUnique({
      where: { walletAddress },
      select: { submissionCount: true, totalEarnedWei: true },
    });

    if (shouldUpdateTotals && user) {
      await tx.user.update({
        where: { walletAddress },
        data: {
          submissionCount: user.submissionCount + 1,
          totalEarnedWei: user.totalEarnedWei + amount,
        },
      });
    }
  } catch (err: any) {
    console.error(`[payout-service] reprocess failed for submission ${submissionId}:`, err);

    if (err instanceof PayoutCapError || err?.name === "PayoutCapError") {
      await tx.submission.update({
        where: { id: submissionId },
        data: {
          payoutStatus: "pending",
          retryCount: fresh.retryCount,
          lastRetriedAt: fresh.lastRetriedAt,
        },
      });
      return;
    }

    await tx.submission.update({
      where: { id: submissionId },
      data: {
        payoutStatus: "failed",
        retryCount: fresh.retryCount + 1,
        lastRetriedAt: new Date(),
      },
    });

    throw err;
  }
}

export async function reprocessPayoutWithNonceSafety(submissionId: string): Promise<void> {
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
  if (!submission) throw new Error("Target submission record not found.");

  if (submission.payoutStatus === "confirmed" || submission.payoutStatus === "sent" || submission.payoutStatus === "skipped") {
    return;
  }

  const amount = submission.payoutAmountWei;

  return prisma.$transaction((tx) => reprocessCore(tx, submissionId, submission.walletAddress, amount));
}

export async function reprocessPayoutWithNonceSafetyTx(
  tx: any,
  submissionId: string,
  walletAddress: string,
  amount: bigint,
): Promise<void> {
  return reprocessCore(tx, submissionId, walletAddress, amount);
}
