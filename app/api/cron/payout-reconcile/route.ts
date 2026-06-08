import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { waitForTx } from "@/lib/payout";
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

    const results = { confirmed: 0, failed: 0, skipped: 0 };

    for (const sub of unconfirmed) {
      if (!sub.payoutTxHash) {
        results.skipped++;
        continue;
      }

      try {
        const receipt = await waitForTx(sub.payoutTxHash as `0x${string}`);
        await prisma.submission.update({
          where: { id: sub.id },
          data: {
            payoutStatus: receipt.status === "success" ? "confirmed" : "failed",
            ...(receipt.status !== "success" ? { retryCount: { increment: 1 } } : {}),
          },
        });
        if (receipt.status === "success") {
          results.confirmed++;
        } else {
          results.failed++;
        }
      } catch (err: any) {
        const isTimeout =
          err?.name === "WaitForTransactionReceiptTimeoutError" ||
          err?.message?.includes("timed out");

        if (isTimeout) {
          continue;
        }

        const isDropped =
          err?.name === "TransactionReceiptNotFoundError" ||
          err?.message?.includes("not found");

        if (!isDropped) {
          console.error(
            `[cron/payout-reconcile] receipt check failed for submission ${sub.id}:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }

        console.error(
          `[cron/payout-reconcile] transaction dropped for submission ${sub.id}:`,
          err instanceof Error ? err.message : err,
        );
        await prisma.submission.update({
          where: { id: sub.id },
          data: { payoutStatus: "failed", retryCount: { increment: 1 } },
        });
        results.failed++;
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
