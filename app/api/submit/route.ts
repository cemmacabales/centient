import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { payReward, rewardInWei } from "@/lib/payout";
import { isRateLimited, isSpamReason } from "@/lib/quality";

const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://celoscan.io";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { walletAddress: rawWallet, taskId, choice, reason } =
    (body ?? {}) as {
      walletAddress?: string;
      taskId?: string;
      choice?: string;
      reason?: string;
    };

  const walletAddress = typeof rawWallet === "string" ? rawWallet.toLowerCase() : "";
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }
  if (typeof taskId !== "string" || !taskId) {
    return NextResponse.json({ error: "invalid_task" }, { status: 400 });
  }
  if (choice !== "A" && choice !== "B") {
    return NextResponse.json({ error: "invalid_choice" }, { status: 400 });
  }
  if (typeof reason !== "string" || isSpamReason(reason)) {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400 });
  }

  if (isRateLimited(walletAddress)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const user = await prisma.user.upsert({
    where: { walletAddress },
    create: { walletAddress },
    update: {},
  });

  if (user.isBanned) {
    return NextResponse.json({ error: "banned" }, { status: 403 });
  }

  const existing = await prisma.submission.findUnique({
    where: { walletAddress_taskId: { walletAddress, taskId } },
  });
  if (existing) {
    return NextResponse.json({ error: "already_submitted" }, { status: 409 });
  }

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  if (task.isGold) {
    const correct = choice === task.goldAnswer;

    if (!correct) {
      await prisma.$transaction(async (tx) => {
        await tx.submission.create({
          data: {
            walletAddress,
            taskId,
            choice,
            reason: reason.trim(),
            isGoldCheck: true,
            goldPassed: false,
            payoutAmountWei: 0n,
            payoutStatus: "skipped",
          },
        });
        await tx.user.update({
          where: { walletAddress },
          data: { goldAttempted: { increment: 1 } },
        });
      });

      const refreshed = await prisma.user.findUniqueOrThrow({
        where: { walletAddress },
      });
      if (
        refreshed.goldAttempted >= 3 &&
        refreshed.goldCorrect / refreshed.goldAttempted < 0.5
      ) {
        await prisma.user.update({
          where: { walletAddress },
          data: { isBanned: true },
        });
      }

      return NextResponse.json({ paid: false, reason: "quality_check_failed" });
    }

    await prisma.user.update({
      where: { walletAddress },
      data: {
        goldCorrect: { increment: 1 },
        goldAttempted: { increment: 1 },
      },
    });
  }

  const recent = await prisma.submission.findMany({
    where: { walletAddress },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { choice: true },
  });
  if (recent.length >= 20) {
    const sameSide = recent.filter((s) => s.choice === choice).length;
    if (sameSide / recent.length > 0.95) {
      await prisma.submission.create({
        data: {
          walletAddress,
          taskId,
          choice,
          reason: reason.trim(),
          isGoldCheck: task.isGold,
          payoutAmountWei: 0n,
          payoutStatus: "skipped",
        },
      });
      return NextResponse.json({ error: "left_bias_detected" }, { status: 400 });
    }
  }

  const amount = rewardInWei();
  const submission = await prisma.submission.create({
    data: {
      walletAddress,
      taskId,
      choice,
      reason: reason.trim(),
      isGoldCheck: task.isGold,
      goldPassed: task.isGold ? true : null,
      payoutAmountWei: amount,
      payoutStatus: "pending",
    },
  });

  try {
    const txHash = await payReward(walletAddress as `0x${string}`);
    await prisma.$transaction([
      prisma.submission.update({
        where: { id: submission.id },
        data: { payoutStatus: "sent", payoutTxHash: txHash },
      }),
      prisma.user.update({
        where: { walletAddress },
        data: {
          submissionCount: { increment: 1 },
          totalEarnedWei: { increment: amount },
        },
      }),
    ]);

    return NextResponse.json({
      paid: true,
      txHash,
      explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
    });
  } catch {
    await prisma.submission.update({
      where: { id: submission.id },
      data: { payoutStatus: "failed" },
    });
    return NextResponse.json({ error: "payout_failed" }, { status: 500 });
  }
}
