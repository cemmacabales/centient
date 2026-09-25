import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { StellarPaymentError } from "@/lib/stellar/client";
import { authenticateCron } from "@/lib/cron-auth";
import { SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";

export const dynamic = "force-dynamic";

const MAX_RETRIES = SUBMISSION_RETRY_BUDGET;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 8 * 60_000;
const STUCK_PAYOUT_THRESHOLD_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  const authErr = authenticateCron(req);
  if (authErr) return authErr;

  try {
    // #37: a row whose SUBMISSION_PAYOUT job is still queued or processing
    // belongs to the payout worker, which may be about to broadcast it. The
    // worker also takes this row's retry claim before it broadcasts, so a race
    // here stands one side down; skipping live jobs keeps the cron from
    // contending for work the worker owns in the first place.
    const stuckPending = await prisma.$queryRaw`
      SELECT id, "walletAddress", "retryCount"
      FROM "submissions" s
      WHERE "payoutStatus" = 'pending'
        AND "retryCount" < ${MAX_RETRIES}
        AND NOT EXISTS (
          SELECT 1 FROM "payout_jobs" j
          WHERE j."submissionId" = s.id AND j."status" IN ('queued', 'processing')
        )
        AND EXTRACT(EPOCH FROM (NOW() - "createdAt")) * 1000 > ${STUCK_PAYOUT_THRESHOLD_MS}
      ORDER BY "createdAt" ASC
      LIMIT 100
    `;

    const eligibleFailed = await prisma.$queryRaw`
      SELECT id, "walletAddress", "retryCount"
      FROM "submissions" s
      WHERE "payoutStatus" = 'failed'
        AND "retryCount" < ${MAX_RETRIES}
        AND NOT EXISTS (
          SELECT 1 FROM "payout_jobs" j
          WHERE j."submissionId" = s.id AND j."status" IN ('queued', 'processing')
        )
        AND EXTRACT(EPOCH FROM (NOW() - COALESCE("lastRetriedAt", "createdAt"))) * 1000
            >= LEAST(POWER(2, "retryCount") * ${BASE_BACKOFF_MS}, ${MAX_BACKOFF_MS})
      ORDER BY "lastRetriedAt" ASC NULLS FIRST, "createdAt" ASC
      LIMIT 100
    `;

    const candidates = [
      ...(Array.isArray(stuckPending) ? stuckPending : []),
      ...(Array.isArray(eligibleFailed) ? eligibleFailed : []),
    ];

    // Deduplicate by id (a submission shouldn't appear in both sets, but belt-and-suspenders)
    const seen = new Set<string>();
    const jobsToRetry = [];
    for (const row of candidates) {
      const id = (row as any).id;
      if (!seen.has(id)) {
        seen.add(id);
        jobsToRetry.push(row as any);
      }
    }
    // Keep the 100-row cap after deduplication
    const cappedJobs = jobsToRetry.slice(0, 100);

    // Group by wallet so parallelization is safe (advisory lock prevents wallet collisions)
    const byWallet = new Map<string, any[]>();
    for (const job of cappedJobs) {
      const wallet = job.walletAddress;
      if (!byWallet.has(wallet)) byWallet.set(wallet, []);
      byWallet.get(wallet)!.push(job);
    }

    const results = { abandoned: 0, retried: 0, errored: 0 };

    await Promise.all(
      Array.from(byWallet.entries()).map(async ([, jobs]) => {
        for (const job of jobs) {
          try {
            await reprocessPayoutWithNonceSafety(job.id);
            results.retried++;
          } catch (err: any) {
            // Non-retryable rail errors (`op_no_trust` — recipient holds no USDC
            // trustline; `op_no_destination` — recipient unfunded) can never
            // succeed on a blind retry. Record the reason and exhaust the retry
            // budget so the abandon sweep below finalizes it: it stays failed
            // until the recipient adds a trustline and re-withdraws.
            if (err instanceof StellarPaymentError && !err.retryable) {
              await prisma.submission
                .update({
                  where: { id: job.id },
                  data: {
                    payoutError: `non-retryable (${err.code})`,
                    retryCount: MAX_RETRIES,
                  },
                })
                .catch((updateErr) => {
                  // If this fails, retryCount isn't exhausted and the job will be
                  // retried again on the next cron pass — not a fund-loss risk, but
                  // wasteful, so surface it rather than swallowing silently.
                  console.error(
                    `[cron/payout-retry] failed to record non-retryable error for submission ${job.id}:`,
                    updateErr instanceof Error ? updateErr.message : updateErr,
                  );
                });
            }
            console.error(
              `[cron/payout-retry] retry failed for submission ${job.id}:`,
              err instanceof Error ? err.message : err,
            );
            results.errored++;
          }
        }
      }),
    );

    const { count: abandoned } = await prisma.submission.updateMany({
      where: {
        payoutStatus: { in: ["failed", "pending"] },
        retryCount: { gte: MAX_RETRIES },
      },
      data: { payoutStatus: "abandoned" },
    });
    results.abandoned = abandoned;

    return NextResponse.json({ message: "Cron cycle complete", ...results }, { status: 200 });
  } catch (globalErr: any) {
    console.error("[cron/payout-retry] cron cycle crashed:", globalErr);
    return NextResponse.json({ error: "Cron cycle crashed" }, { status: 500 });
  }
}
