import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getLabelerSession } from "@/lib/labeler-auth";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";

const RECENT_LEDGER_LIMIT = 20;

/**
 * GET /api/me/balance — the logged-in labeler's accumulating off-chain balance.
 *
 * Session-scoped (not wallet-keyed): the accumulate-then-withdraw model splits
 * identity from the payout wallet, so the balance belongs to the `User`, not an
 * address. Returns the pending balance plus the most recent ledger entries so
 * the client can show "recent credits" — this replaces the per-submission
 * "payout sent" poll.
 */
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pendingBalanceUnits: true },
  });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ledger = await prisma.userBalanceLedger.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: RECENT_LEDGER_LIMIT,
    select: {
      id: true,
      type: true,
      amountUnits: true,
      submissionId: true,
      note: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    pendingBalanceUnits: user.pendingBalanceUnits.toString(),
    pendingBalance: unitsToUsdcDisplay(user.pendingBalanceUnits),
    rewardSymbol: REWARD_TOKEN_SYMBOL,
    ledger: ledger.map((e) => ({
      id: e.id,
      type: e.type,
      amountUnits: e.amountUnits.toString(),
      amount: unitsToUsdcDisplay(e.amountUnits),
      submissionId: e.submissionId,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
