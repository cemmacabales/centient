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

  // Phase 1: validate and claim the submission for retry under a row lock. The
  // on-chain payout is deliberately NOT broadcast inside this transaction (see
  // phase 2) so that a post-send DB failure can never roll back the persisted
  // txHash and cause a double payment.
  const claim = await prisma.$transaction(async (tx) => {
    const submission = await tx.$queryRaw`
      SELECT id, "payoutStatus", "retryCount", "lastRetriedAt", "walletAddress", "payoutAmountStroops"
      FROM "submissions" WHERE id = ${id} FOR UPDATE
    `;

    const row = Array.isArray(submission) ? submission[0] : submission;

    if (!row) {
      return { kind: "not_found" as const };
    }

    if (row.payoutStatus !== "failed" && row.payoutStatus !== "abandoned") {
      return { kind: "bad_status" as const, status: row.payoutStatus };
    }

    const originals = {
      retryCount: row.retryCount,
      status: row.payoutStatus,
      lastRetriedAt: row.lastRetriedAt,
    };

    await tx.submission.update({
      where: { id },
      data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
    });

    console.warn(
      `[admin/retry] operator ${session.email} manually triggered retry for submission ${id} (was ${originals.status}, retryCount reset from ${originals.retryCount})`,
    );

    return { kind: "ok" as const, originals };
  });

  if (claim.kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (claim.kind === "bad_status") {
    return NextResponse.json(
      { error: `cannot retry submission with status "${claim.status}"` },
      { status: 400 },
    );
  }

  // Phase 2: broadcast the retry outside the transaction. reprocessPayoutWithNonceSafety
  // persists the txHash + "sent" status atomically the instant the on-chain tx returns.
  try {
    await reprocessPayoutWithNonceSafety(id);
    return NextResponse.json({ message: "Payout retry triggered successfully" }, { status: 200 });
  } catch (err: any) {
    console.error(`[admin/retry] manual retry failed for submission ${id}:`, err);

    // Only restore the original status if the txHash was never persisted. If it was
    // saved, the submission is already "sent"; overwriting it to "failed" would create
    // contradictory state — the reconciler verifies on-chain and transitions correctly.
    const current = await prisma.submission.findUnique({
      where: { id },
      select: { payoutTxHash: true },
    });
    if (!current?.payoutTxHash) {
      await prisma.submission.update({
        where: { id },
        data: {
          retryCount: claim.originals.retryCount,
          lastRetriedAt: claim.originals.lastRetriedAt,
          payoutStatus: claim.originals.status,
        },
      });
    }

    return NextResponse.json(
      { error: "payout_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
