import prisma from "./prisma";
import { creditBalance, totalDebitUnits } from "./campaign-balance";

/**
 * Credit a finally-failed submission payout back to its campaign balance: the
 * reward plus the platform fee that `checkAndDebit` took at submit. Gold tasks
 * and campaign-less tasks draw from no campaign budget, so they are a no-op.
 * Best-effort: a failure here must not mask the payout error that triggered it.
 *
 * Callers refund only on the decision that the payout is over — the worker when
 * it exhausts or cannot retry a job, the retry path when it exhausts
 * `SUBMISSION_RETRY_BUDGET` — and never for an `ambiguous_submit`, which may
 * have settled on-chain.
 */
export async function refundCampaignBalance(
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
    // Keyed, so a second payer giving up on the same payout refunds nothing.
    submissionId,
  ).catch(() => {});
}

/** `refundCampaignBalance` for a caller holding only the submission id. */
export async function refundSubmissionDebit(
  submissionId: string,
  amountUnits: bigint,
  reason: string,
): Promise<void> {
  const row = await prisma.submission
    .findUnique({
      where: { id: submissionId },
      select: { task: { select: { isGold: true, campaignId: true } } },
    })
    .catch(() => null);
  if (!row) return;
  await refundCampaignBalance(row.task, submissionId, amountUnits, reason);
}
