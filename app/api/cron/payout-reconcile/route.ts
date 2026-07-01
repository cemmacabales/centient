import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getTxStatus } from "@/lib/stellar/client";
import { authenticateCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const authErr = authenticateCron(req);
  if (authErr) return authErr;

  try {
    const unconfirmed = await prisma.submission.findMany({
      where: { payoutStatus: "sent", payoutTxHash: { not: null } },
      select: { id: true, payoutTxHash: true },
      take: 50,
    });

    const results = { confirmed: 0, failed: 0 };

    for (const sub of unconfirmed) {
      try {
        // Horizon (ST-1b): confirmed | failed | not_found.
        const status = await getTxStatus(sub.payoutTxHash as string);

        if (status === "confirmed") {
          await prisma.submission.update({
            where: { id: sub.id },
            data: { payoutStatus: "confirmed" },
          });
          results.confirmed++;
        } else if (status === "failed") {
          await prisma.submission.update({
            where: { id: sub.id },
            data: { payoutStatus: "failed", retryCount: { increment: 1 } },
          });
          results.failed++;
        }
        // not_found: still pending on Horizon (read-lag, not a drop — a Stellar
        // tx only gets a hash once ledger-included). Leave it `sent` for the next
        // cycle without burning a retry.
      } catch (err: any) {
        // Transient Horizon read error — skip; next cycle retries.
        console.error(
          `[cron/payout-reconcile] Horizon status check failed for submission ${sub.id}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
    }

    return NextResponse.json(
      { message: "Reconcile cycle complete", ...results },
      { status: 200 },
    );
  } catch (globalErr: any) {
    console.error("[cron/payout-reconcile] reconcile cycle crashed:", globalErr);
    return NextResponse.json({ error: "Reconcile cycle crashed" }, { status: 500 });
  }
}
