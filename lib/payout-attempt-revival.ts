import prisma from "./prisma";
import { claimSubmissionForBroadcast } from "./payout-service";
import { settleOpenAttempt, type SettlementHorizon } from "./payout-attempts";
import { hasRefundedSubmission } from "./campaign-balance";
import { SUBMISSION_RETRY_BUDGET } from "./payout-retry-claim";

// #38 — unknown payout outcomes stay reconcilable.
//
// A submit whose outcome could not be proven (`ambiguous_submit`, not
// retryable) ends with the submission `failed`, its retry budget spent, no
// refund, and its envelope still `open`. No payer returns to it, and the retry
// cron's abandon sweep may relabel it `abandoned`. Once the envelope's fate can
// be proven, this hands the row back to the retry path, which settles the same
// envelope again and either records the payment that landed or builds the one
// replacement. The retry path stays the only thing that writes a payment.

const BATCH = 20;

/** Why a stranded row was, or was not, handed back. */
export type Revival = "revived" | "waiting" | "skipped";

/**
 * Settle the open envelopes of stranded submissions past their time bounds and
 * put every one whose fate is now proven back into the retry path. Returns what
 * happened to each, by submission id.
 */
export async function reviveStrandedAttempts(
  horizon?: SettlementHorizon,
): Promise<Record<string, Revival>> {
  // Rows this will never revive — refunded, or with no wallet to pay — are
  // excluded here rather than skipped below. Skipped in code they would stay the
  // oldest rows, fill every batch, and starve the stranded rows behind them.
  // The refund match mirrors `hasRefundedSubmission`: by id, or by the note of a
  // refund written before refunds carried one.
  const stranded = await prisma.$queryRaw<{ id: string; walletAddress: string }[]>`
    SELECT s."id", s."walletAddress"
    FROM "payout_attempts" a
    JOIN "submissions" s ON s."id" = a."submissionId"
    WHERE a."status" = 'open'
      AND a."expiresAt" < NOW()
      AND s."payoutStatus" IN ('failed', 'abandoned')
      AND s."payoutTxHash" IS NULL
      AND s."retryCount" >= ${SUBMISSION_RETRY_BUDGET}
      AND s."walletAddress" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "balance_ledger" b
        WHERE b."type" = 'REFUND'
          AND (b."submissionId" = s."id" OR b."note" LIKE '%for submission ' || s."id")
      )
    ORDER BY a."expiresAt" ASC
    LIMIT ${BATCH}
  `;

  const outcome: Record<string, Revival> = {};
  for (const submission of stranded) {
    outcome[submission.id] = await revive(submission.id, submission.walletAddress, horizon);
  }
  return outcome;
}

async function revive(
  submissionId: string,
  walletAddress: string,
  horizon?: SettlementHorizon,
): Promise<Revival> {
  // A refunded payout is over. Paying it now, landed or rebuilt, would be paid
  // with no funding behind it (#37). The query already excludes these; this
  // re-checks under the time between that read and now.
  if (await hasRefundedSubmission(prisma, submissionId)) return "skipped";

  // Held while settling and handing back, so no admin retry resets the row
  // underneath this.
  if (!(await claimSubmissionForBroadcast(submissionId, walletAddress))) return "skipped";

  const settled = await settleOpenAttempt(submissionId, horizon);
  if (settled.kind === "wait") {
    await prisma.submission.updateMany({
      where: { id: submissionId, payoutTxHash: null },
      data: { lastRetriedAt: null },
    });
    return "waiting";
  }

  // Proven either way. The retry path picks it up on its next pass: a landed
  // envelope is still open and is recorded there, and a void one is replaced
  // there, both under the same claim and settlement every payer uses.
  await prisma.submission.updateMany({
    where: { id: submissionId, payoutTxHash: null },
    data: {
      payoutStatus: "failed",
      retryCount: 0,
      lastRetriedAt: null,
      payoutError:
        settled.kind === "paid"
          ? `envelope ${settled.hash} landed; returned to the retry path to record it`
          : "earlier envelope proven never applied; returned to the retry path",
    },
  });
  return "revived";
}
