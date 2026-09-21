import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";
import { getLabelerSession } from "@/lib/labeler-auth";

/**
 * Read one of the signed-in contributor's submissions and its payout status:
 * `pending` (queued, not yet broadcast), `sent` (accepted by Horizon, hash
 * stored), `confirmed` (seen on the ledger by the reconciler), or a failure
 * state (#37).
 *
 * The session is the only authority. The row is matched on its `userId`, never
 * on a wallet parameter: the old `?walletAddress=0x…` check rejected every
 * Stellar `G…` address, and lowercasing a StrKey to compare it is wrong anyway.
 * Someone else's submission answers 404, exactly like a missing one, so an id
 * says nothing about whether it exists.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const submission = await prisma.submission.findFirst({
    where: { id, userId },
    select: {
      id: true,
      payoutStatus: true,
      payoutTxHash: true,
      payoutAmountUnits: true,
      walletAddress: true,
      taskId: true,
      createdAt: true,
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    id: submission.id,
    payoutStatus: submission.payoutStatus,
    payoutTxHash: submission.payoutTxHash,
    payoutAmount: unitsToUsdcDisplay(submission.payoutAmountUnits),
    payoutSymbol: REWARD_TOKEN_SYMBOL,
    walletAddress: submission.walletAddress,
    taskId: submission.taskId,
    createdAt: submission.createdAt.toISOString(),
  });
}
