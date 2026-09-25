import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { RETRY_CLAIM_LEASE_MS, retryClaimIsLive, SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";
import { hasRefundedSubmission } from "@/lib/campaign-balance";

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
      SELECT id, "payoutStatus", "retryCount", "lastRetriedAt", "walletAddress", "payoutAmountUnits"
      FROM "submissions" WHERE id = ${id} FOR UPDATE
    `;

    const row = Array.isArray(submission) ? submission[0] : submission;

    if (!row) {
      return { kind: "not_found" as const };
    }

    if (row.payoutStatus !== "failed" && row.payoutStatus !== "abandoned") {
      return { kind: "bad_status" as const, status: row.payoutStatus };
    }

    // A retry in flight holds a lease on `lastRetriedAt`, and the reset below
    // would clear it — leaving nothing for the claim in phase 2 to stand down
    // on, so both attempts broadcast. A row mid-broadcast still reads `failed`
    // with no hash, so the status check above cannot see it; this is the only
    // thing that can. Refuse rather than reset a lease we do not own.
    //
    // `retryClaimIsLive` is conservative by construction (see its docstring), so
    // this also refuses for up to a minute after a retry that has already
    // finished. Say that plainly below rather than asserting a broadcast is in
    // flight — an operator who is told the wrong thing about a payout stops
    // trusting the ones they are told correctly.
    if (retryClaimIsLive(row.lastRetriedAt)) {
      return { kind: "claim_held" as const, lastRetriedAt: row.lastRetriedAt as Date };
    }

    // #37: a payer that gave up on this payout returned its campaign debit. A
    // retry now would pay it from platform funds while the campaign keeps the
    // refund — and a second give-up would refund it again. Refuse; an operator
    // who wants it paid re-funds it first.
    if (await hasRefundedSubmission(tx, id)) {
      return { kind: "refunded" as const };
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
  if (claim.kind === "refunded") {
    return NextResponse.json(
      {
        error: "payout_refunded",
        detail:
          "this submission's campaign debit was refunded when its payout was given up; retrying would pay it with no funding behind it",
      },
      { status: 409 },
    );
  }
  if (claim.kind === "claim_held") {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (RETRY_CLAIM_LEASE_MS - (Date.now() - claim.lastRetriedAt.getTime())) / 1000,
      ),
    );
    return NextResponse.json(
      {
        error: "retry_claim_held",
        detail:
          "a retry was claimed for this submission less than a minute ago and may still be in flight; retrying now could pay it twice",
        retryAfterSeconds,
      },
      { status: 409, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  // Phase 2: broadcast the retry outside the transaction. reprocessPayoutWithNonceSafety
  // persists the txHash + "sent" status atomically the instant the on-chain tx returns.
  try {
    await reprocessPayoutWithNonceSafety(id);
    return NextResponse.json({ message: "Payout retry triggered successfully" }, { status: 200 });
  } catch (err: any) {
    console.error(`[admin/retry] manual retry failed for submission ${id}:`, err);

    // Restore the row this request claimed — but only when the failure left
    // nothing behind that the restore would undo.
    //
    // The old guard was "no txHash", which only covers a payout that broadcast.
    // It misses the case that matters (F2): `reprocessPayoutWithNonceSafety` can
    // hit a non-retryable rail error (`op_no_trust`, `op_no_destination`), write
    // `retryCount = SUBMISSION_RETRY_BUDGET` to take the row out of the retry
    // path, refund the campaign debit, and only then throw. There is no hash, so
    // the old guard restored the pre-request `failed`/low `retryCount` over
    // exactly those two markers — and the cron, which does not exclude refunded
    // rows, would then pay a submission whose funding had already gone back.
    //
    // Under the row lock, refuse the restore whenever the payout is now
    // terminal, refunded, or out of budget. Leaving the row as the failure left
    // it is always safe: it is the state the same failure reached by any other
    // path.
    await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        { payoutStatus: string; payoutTxHash: string | null; retryCount: number }[]
      >`
        SELECT "payoutStatus", "payoutTxHash", "retryCount" FROM "submissions"
        WHERE "id" = ${id} FOR UPDATE
      `;
      if (!row) return;

      if (row.payoutTxHash) return;
      if (row.payoutStatus !== "pending") return;
      if (row.retryCount >= SUBMISSION_RETRY_BUDGET) return;
      if (await hasRefundedSubmission(tx, id)) return;

      await tx.submission.update({
        where: { id },
        data: {
          retryCount: claim.originals.retryCount,
          lastRetriedAt: claim.originals.lastRetriedAt,
          payoutStatus: claim.originals.status,
        },
      });
    });

    return NextResponse.json(
      { error: "payout_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
