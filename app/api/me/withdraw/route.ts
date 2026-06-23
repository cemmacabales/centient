import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import prisma from "@/lib/prisma";
import { MIN_WITHDRAWAL_THRESHOLD_WEI } from "@/lib/constants";

async function getAdvisoryLock(userId: string): Promise<void> {
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
}

export async function GET(req: NextRequest) {
  const walletSession = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(walletSession);
  if (unauthorized) return unauthorized;
  const wallet = walletSession!.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { walletAddress: wallet },
    select: { id: true, pendingBalanceWei: true },
  });

  if (!user) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  const withdrawals = await prisma.userWithdrawal.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return NextResponse.json({
    pendingBalanceWei: user.pendingBalanceWei.toString(),
    thresholdWei: MIN_WITHDRAWAL_THRESHOLD_WEI.toString(),
    canWithdraw: user.pendingBalanceWei >= MIN_WITHDRAWAL_THRESHOLD_WEI,
    withdrawals: withdrawals.map((w) => ({
      id: w.id,
      amountWei: w.amountWei.toString(),
      status: w.status,
      txHash: w.txHash,
      createdAt: w.createdAt.toISOString(),
      completedAt: w.completedAt?.toISOString() ?? null,
      error: w.lastError,
    })),
  });
}

export async function POST(req: NextRequest) {
  const walletSession = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(walletSession);
  if (unauthorized) return unauthorized;
  const wallet = walletSession!.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { walletAddress: wallet },
    select: { id: true, pendingBalanceWei: true },
  });

  if (!user) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  if (user.pendingBalanceWei < MIN_WITHDRAWAL_THRESHOLD_WEI) {
    return NextResponse.json(
      {
        error: "below_threshold",
        pendingBalanceWei: user.pendingBalanceWei.toString(),
        thresholdWei: MIN_WITHDRAWAL_THRESHOLD_WEI.toString(),
      },
      { status: 400 },
    );
  }

  await getAdvisoryLock(user.id);

  const pendingWithdrawal = await prisma.userWithdrawal.findFirst({
    where: { userId: user.id, status: { in: ["queued", "processing"] } },
  });

  if (pendingWithdrawal) {
    return NextResponse.json(
      { error: "withdrawal_in_progress", withdrawalId: pendingWithdrawal.id },
      { status: 409 },
    );
  }

  const amountWei = user.pendingBalanceWei;

  const withdrawal = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { pendingBalanceWei: 0n },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId: user.id,
        type: "WITHDRAWAL",
        amountWei,
        note: `Withdrawal initiated`,
      },
    });

    return tx.userWithdrawal.create({
      data: {
        userId: user.id,
        amountWei,
        status: "queued",
      },
    });
  });

  return NextResponse.json({
    withdrawalId: withdrawal.id,
    amountWei: amountWei.toString(),
    status: withdrawal.status,
  });
}