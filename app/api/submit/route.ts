import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { payReward, rewardInWei } from "@/lib/payout";
import { isRateLimited, isSpamReason } from "@/lib/quality";
import { validateReason } from "@/lib/validators";

const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://celoscan.io";

function errorResponse(code: string, status: number, context: Record<string, unknown> = {}) {
  console.error(`[submit] ${code}`, context);
  return NextResponse.json({ error: code }, { status });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_body", 400);
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
    return errorResponse("invalid_wallet", 400, { walletAddress });
  }
  if (typeof taskId !== "string" || !taskId) {
    return errorResponse("invalid_task", 400, { walletAddress, taskId });
  }
  if (choice !== "A" && choice !== "B") {
    return errorResponse("invalid_choice", 400, { walletAddress, taskId, choice });
  }
  
  if (typeof reason !== "string" || isSpamReason(reason) || !validateReason(reason)) {
    return errorResponse("invalid_reason", 400, { walletAddress, taskId });
  }

  if (isRateLimited(walletAddress)) {
    return errorResponse("rate_limited", 429, { walletAddress });
  }

  try {
    const user = await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress },
      update: {},
    });

    if (user.isBanned) {
      return errorResponse("banned", 403, { walletAddress });
    }

    const existing = await prisma.submission.findUnique({
      where: { walletAddress_taskId: { walletAddress, taskId } },
    });
    if (existing) {
      return errorResponse("already_submitted", 409, { walletAddress, taskId });
    }

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return errorResponse("task_not_found", 404, { walletAddress, taskId });
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
          console.warn("[submit] banned_wallet", {
            walletAddress,
            goldAttempted: refreshed.goldAttempted,
            goldCorrect: refreshed.goldCorrect,
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
        return errorResponse("left_bias_detected", 400, {
          walletAddress,
          taskId,
          sameSide,
          recent: recent.length,
        });
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
    } catch (err) {
      await prisma.submission.update({
        where: { id: submission.id },
        data: { payoutStatus: "failed" },
      });
      return errorResponse("payout_failed", 500, {
        walletAddress,
        taskId,
        submissionId: submission.id,
        err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      });
    }
  } catch (err) {
    return errorResponse("server_error", 500, {
      walletAddress,
      taskId,
      err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    });
  }
}
