import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { reprocessPayoutWithNonceSafetyTx } from "@/lib/payout-service";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { id } = await params;

  return prisma.$transaction(async (tx) => {
    const submission = await tx.$queryRaw`
      SELECT id, payout_status, retry_count, last_retried_at, wallet_address, payout_amount_wei
      FROM "submissions" WHERE id = ${id} FOR UPDATE
    `;

    const row = Array.isArray(submission) ? submission[0] : submission;

    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    if (row.payout_status !== "failed" && row.payout_status !== "abandoned") {
      return NextResponse.json(
        { error: `cannot retry submission with status "${row.payout_status}"` },
        { status: 400 },
      );
    }

    const originalRetryCount = row.retry_count;
    const originalStatus = row.payout_status;
    const originalLastRetriedAt = row.last_retried_at;

    await tx.submission.update({
      where: { id },
      data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
    });

    console.warn(
      `[admin/retry] operator ${session.email} manually triggered retry for submission ${id} (was ${originalStatus}, retryCount reset from ${originalRetryCount})`,
    );

    try {
      await reprocessPayoutWithNonceSafetyTx(
        tx,
        id,
        row.wallet_address,
        BigInt(row.payout_amount_wei),
      );
      return NextResponse.json({ message: "Payout retry triggered successfully" }, { status: 200 });
    } catch (err: any) {
      console.error(`[admin/retry] manual retry failed for submission ${id}:`, err);

      await tx.submission.update({
        where: { id },
        data: {
          retryCount: originalRetryCount,
          lastRetriedAt: originalLastRetriedAt,
          payoutStatus: originalStatus,
        },
      });

      return NextResponse.json(
        { error: "payout_failed", detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  });
}
