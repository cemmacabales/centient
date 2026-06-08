import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isStuckPending } from "@/lib/admin-data";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { authenticateCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 8 * 60_000;

export async function POST(req: NextRequest) {
  const authErr = authenticateCron(req);
  if (authErr) return authErr;

  try {
    const now = new Date();

    const candidates = await prisma.submission.findMany({
      where: {
        payoutStatus: { in: ["failed", "pending"] },
        retryCount: { lt: MAX_RETRIES },
      },
      orderBy: [
        { lastRetriedAt: "asc" },
        { createdAt: "asc" },
      ],
      take: 100,
      select: {
        id: true,
        payoutStatus: true,
        retryCount: true,
        lastRetriedAt: true,
        createdAt: true,
      },
    });

    const jobsToRetry = candidates.filter((submission) => {
      if (submission.payoutStatus === "pending") {
        return isStuckPending(submission.createdAt, now);
      }

      if (submission.payoutStatus === "failed") {
        const backoffDelay = Math.min(
          Math.pow(2, submission.retryCount) * BASE_BACKOFF_MS,
          MAX_BACKOFF_MS,
        );
        const lastAttemptAt =
          submission.lastRetriedAt?.getTime() ?? submission.createdAt.getTime();
        return now.getTime() - lastAttemptAt >= backoffDelay;
      }

      return false;
    });

    const results = { abandoned: 0, retried: 0, errored: 0 };

    for (const submission of jobsToRetry) {
      try {
        await reprocessPayoutWithNonceSafety(submission.id);
        results.retried++;
      } catch (err: any) {
        console.error(
          `[cron/payout-retry] retry failed for submission ${submission.id}:`,
          err instanceof Error ? err.message : err,
        );
        results.errored++;
      }
    }

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
