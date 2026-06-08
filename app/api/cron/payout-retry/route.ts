import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { authenticateCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 8 * 60_000;
const STUCK_PAYOUT_THRESHOLD_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  const authErr = authenticateCron(req);
  if (authErr) return authErr;

  try {
    const stuckPending = await prisma.$queryRaw`
      SELECT id, wallet_address, retry_count
      FROM "submissions"
      WHERE payout_status = 'pending'
        AND retry_count < ${MAX_RETRIES}
        AND EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 > ${STUCK_PAYOUT_THRESHOLD_MS}
      ORDER BY created_at ASC
      LIMIT 100
    `;

    const eligibleFailed = await prisma.$queryRaw`
      SELECT id, wallet_address, retry_count
      FROM "submissions"
      WHERE payout_status = 'failed'
        AND retry_count < ${MAX_RETRIES}
        AND EXTRACT(EPOCH FROM (NOW() - COALESCE(last_retried_at, created_at))) * 1000
            >= LEAST(POWER(2, retry_count) * ${BASE_BACKOFF_MS}, ${MAX_BACKOFF_MS})
      ORDER BY last_retried_at ASC NULLS FIRST, created_at ASC
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
      const wallet = job.wallet_address;
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
