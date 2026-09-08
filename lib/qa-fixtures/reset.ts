// Return a QA run's fixtures to nothing, without ever removing a record of money
// that actually moved.
//
// The three rules from the readiness guide, and where each one lives:
//
//   1. Never delete or rewrite a row carrying a transaction hash. Enforced by
//      `isResettableHash`, on the hash's shape rather than on any marker the
//      seeder set — see `hash.ts` for why that distinction is the whole point.
//   2. Never reuse a payout reference. Enforced upstream: the seeder mints fresh
//      UUIDs every run, so there is nothing here to check.
//   3. Record every reset. The `QaFixtureRun` row is updated in place with what
//      went, what stayed, and when.
//
// A row that cannot be deleted is not an error and does not abort the reset. It
// is reported, counted, and left exactly where it is — because the situation it
// describes (a fixture reference that settled on-chain) is one QA needs to see
// rather than one the tool should resolve on its own.
import type { PrismaClient } from "../../app/generated/prisma/client";
import { isRealBroadcastHash, isResettableHash } from "./hash";

export interface PreservedRow {
  kind: "submission" | "payout_job";
  id: string;
  txHash: string;
  /** Why it survived: a real Horizon hash, or one nothing recognises. */
  reason: "real-broadcast" | "unrecognised-hash";
}

export interface ResetResult {
  runId: string;
  deletedCount: number;
  preservedCount: number;
  preserved: PreservedRow[];
  campaignRemoved: boolean;
}

export class QaFixtureRunNotFound extends Error {
  constructor(runId: string) {
    super(`qa-fixtures: no seeded run with id "${runId}".`);
    this.name = "QaFixtureRunNotFound";
  }
}

function preservationReason(txHash: string): PreservedRow["reason"] {
  return isRealBroadcastHash(txHash) ? "real-broadcast" : "unrecognised-hash";
}

/**
 * Reset one run's fixtures.
 *
 * `runId` defaults to the most recent run that has not already been reset, which
 * is what a QA engineer means by "reset" almost every time.
 */
export async function resetQaFixtures(
  prisma: PrismaClient,
  runId?: string,
): Promise<ResetResult> {
  const run = runId
    ? await prisma.qaFixtureRun.findUnique({ where: { runId } })
    : await prisma.qaFixtureRun.findFirst({
        where: { resetAt: null },
        orderBy: { seededAt: "desc" },
      });

  if (!run) throw new QaFixtureRunNotFound(runId ?? "<most recent un-reset>");

  const fixtures = (run.fixtures ?? {}) as Record<string, string>;
  const campaignId = fixtures["campaign"];

  const preserved: PreservedRow[] = [];
  let deletedCount = 0;

  // ── Submissions ──────────────────────────────────────────────────────────
  // Scoped through the campaign rather than through the recorded ids, so a row
  // the seeder created but failed to record is still cleaned up rather than
  // orphaned.
  const submissions = campaignId
    ? await prisma.submission.findMany({
        where: { task: { campaignId } },
        select: { id: true, payoutTxHash: true, taskId: true },
      })
    : [];

  const removableSubmissionIds: string[] = [];
  const removableTaskIds: string[] = [];

  for (const submission of submissions) {
    if (isResettableHash(submission.payoutTxHash)) {
      removableSubmissionIds.push(submission.id);
      removableTaskIds.push(submission.taskId);
    } else {
      preserved.push({
        kind: "submission",
        id: submission.id,
        txHash: submission.payoutTxHash as string,
        reason: preservationReason(submission.payoutTxHash as string),
      });
    }
  }

  if (removableSubmissionIds.length > 0) {
    // `BalanceLedger.submissionId` carries no foreign key by design, so these
    // rows have to go explicitly — nothing cascades them.
    await prisma.balanceLedger.deleteMany({
      where: { submissionId: { in: removableSubmissionIds } },
    });
    // `PayoutJob.submission` cascades, so the per-submission jobs go with these.
    const removed = await prisma.submission.deleteMany({
      where: { id: { in: removableSubmissionIds } },
    });
    deletedCount += removed.count;

    // `submissions.taskId` is ON DELETE RESTRICT. The seeder writes one task per
    // submission, so today every task here is empty by the time we reach this —
    // but the schema permits several submissions on one task, and if one of them
    // were preserved the delete would abort the whole reset partway through.
    // Filtering on emptiness costs nothing and removes that failure mode.
    await prisma.task.deleteMany({
      where: { id: { in: removableTaskIds }, submissions: { none: {} } },
    });
  }

  // ── Standalone payout jobs (the seeded cap usage) ────────────────────────
  const capUsageJobId = fixtures["qa-cap-usage"];
  if (capUsageJobId) {
    const job = await prisma.payoutJob.findUnique({
      where: { id: capUsageJobId },
      select: { id: true, txHash: true },
    });
    if (job) {
      if (isResettableHash(job.txHash)) {
        await prisma.payoutJob.delete({ where: { id: job.id } });
        deletedCount += 1;
      } else {
        preserved.push({
          kind: "payout_job",
          id: job.id,
          txHash: job.txHash as string,
          reason: preservationReason(job.txHash as string),
        });
      }
    }
  }

  // ── The campaign itself ──────────────────────────────────────────────────
  // Removed only once nothing of the run is left inside it. A preserved
  // submission holds its campaign open deliberately: deleting the campaign would
  // orphan the row that records the payment, which is the outcome rule 1 exists
  // to prevent.
  let campaignRemoved = false;
  if (campaignId && preserved.every((row) => row.kind !== "submission")) {
    const remaining = await prisma.submission.count({ where: { task: { campaignId } } });
    if (remaining === 0) {
      await prisma.task.deleteMany({ where: { campaignId } });
      await prisma.balanceLedger.deleteMany({ where: { campaignId } });
      await prisma.campaignBalance.deleteMany({ where: { campaignId } });
      await prisma.campaign.delete({ where: { id: campaignId } });
      campaignRemoved = true;
    }
  }

  await prisma.qaFixtureRun.update({
    where: { runId: run.runId },
    data: {
      resetAt: new Date(),
      deletedCount,
      preservedCount: preserved.length,
      note: preserved.length
        ? `reset preserved ${preserved.length} row(s) carrying a transaction hash`
        : run.note,
    },
  });

  return {
    runId: run.runId,
    deletedCount,
    preservedCount: preserved.length,
    preserved,
    campaignRemoved,
  };
}
