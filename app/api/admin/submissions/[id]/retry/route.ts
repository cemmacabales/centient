import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";

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

  const submission = await prisma.submission.findUnique({
    where: { id },
    select: { id: true, payoutStatus: true, retryCount: true },
  });

  if (!submission) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (submission.payoutStatus !== "failed" && submission.payoutStatus !== "abandoned") {
    return NextResponse.json(
      { error: `cannot retry submission with status "${submission.payoutStatus}"` },
      { status: 400 },
    );
  }

  const originalRetryCount = submission.retryCount;
  const originalStatus = submission.payoutStatus;

  await prisma.submission.update({
    where: { id },
    data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
  });

  console.warn(
    `[admin/retry] operator ${session.email} manually triggered retry for submission ${id} (was ${submission.payoutStatus}, retryCount reset from ${submission.retryCount})`,
  );

  try {
    await reprocessPayoutWithNonceSafety(id);
    return NextResponse.json({ message: "Payout retry triggered successfully" }, { status: 200 });
  } catch (err: any) {
    console.error(`[admin/retry] manual retry failed for submission ${id}:`, err);

    await prisma.submission.update({
      where: { id },
      data: {
        retryCount: originalRetryCount,
        payoutStatus: originalStatus,
      },
    });

    return NextResponse.json(
      { error: "payout_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
