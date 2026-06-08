import prisma from "@/lib/prisma";
import { payReward } from "./payout";

export async function reprocessPayoutWithNonceSafety(submissionId: string): Promise<void> {
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } });
  if (!submission) throw new Error("Target submission record not found.");

  if (submission.payoutStatus === "confirmed" || submission.payoutStatus === "sent" || submission.payoutStatus === "skipped") {
    return;
  }

  const amount = submission.payoutAmountWei;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${submission.walletAddress}))`;

    const fresh = await tx.submission.findUnique({ where: { id: submissionId } });
    if (!fresh) throw new Error("Submission vanished during retry.");
    if (fresh.payoutStatus === "confirmed" || fresh.payoutStatus === "sent" || fresh.payoutStatus === "skipped") {
      return;
    }

    try {
      const txHash = await payReward(submission.walletAddress as `0x${string}`, amount);

      const wasPending = fresh.payoutStatus === "pending";

      await tx.submission.update({
        where: { id: submissionId },
        data: {
          payoutStatus: "sent",
          payoutTxHash: txHash,
          ...(wasPending ? { lastRetriedAt: new Date() } : {}),
        },
      });

      const user = await tx.user.findUnique({
        where: { walletAddress: submission.walletAddress },
        select: { submissionCount: true, totalEarnedWei: true },
      });

      if (wasPending && user) {
        await tx.user.update({
          where: { walletAddress: submission.walletAddress },
          data: {
            submissionCount: user.submissionCount + 1,
            totalEarnedWei: user.totalEarnedWei + amount,
          },
        });
      }
    } catch (err: any) {
      console.error(`[payout-service] reprocess failed for submission ${submissionId}:`, err);

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
  });
}
