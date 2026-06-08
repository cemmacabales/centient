import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { waitForTx } from "@/lib/payout";

export const dynamic = "force-dynamic";

function authenticate(req: NextRequest): NextResponse | null {
  const authHeader = req.headers.get("Authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const authErr = authenticate(req);
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
          data: { payoutStatus: receipt.status === "success" ? "confirmed" : "failed" },
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

        console.error(
          `[cron/payout-reconcile] receipt check failed for submission ${sub.id}:`,
          err instanceof Error ? err.message : err,
        );
        await prisma.submission.update({
          where: { id: sub.id },
          data: { payoutStatus: "failed" },
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
