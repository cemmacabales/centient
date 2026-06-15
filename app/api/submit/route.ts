import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { payReward, resolveRewardWei, PayoutCapError } from "@/lib/payout";
import { isSpamReason, checkReasonRepetition, computeIAA } from "@/lib/quality";
import { checkWalletRateLimit } from "@/lib/rate-limit";
import { validateReason } from "@/lib/validators";
import {
  evaluateBanRule,
  computeCooldownBan,
  isPermanentlyBanned,
  isInCooldown,
  isInRetest,
  RETEST_GOLD_COUNT,
  RETEST_PASS_THRESHOLD,
} from "@/lib/admin-data";

const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://celoscan.io";

function errorResponse(code: string, status: number, context: Record<string, unknown> = {}) {
  console.error(`[submit] ${code}`, context);
  Sentry.captureMessage(`[submit] ${code}`, {
    level: status >= 500 ? "error" : "warning",
    extra: context,
  });
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

  const repetitionCheck = await checkReasonRepetition(walletAddress, reason);
  if (repetitionCheck.isRepetitive) {
    return errorResponse("repetitive_reason", 400, { walletAddress, taskId });
  }

  if (await checkWalletRateLimit(walletAddress)) {
    return errorResponse("rate_limited", 429, { walletAddress });
  }

  try {
    const user = await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress },
      update: {},
    });

    if (isPermanentlyBanned(user.isBanned, user.bannedUntil, user.banCount)) {
      return errorResponse("banned", 403, { walletAddress, permanent: true });
    }
    if (isInCooldown(user.isBanned, user.bannedUntil)) {
      return errorResponse("banned", 403, {
        walletAddress,
        unbannedAt: user.bannedUntil?.toISOString(),
      });
    }

    const existing = await prisma.submission.findUnique({
      where: { walletAddress_taskId: { walletAddress, taskId } },
    });
    if (existing) {
      return errorResponse("already_submitted", 409, { walletAddress, taskId });
    }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        campaign: { select: { defaultResponseTarget: true, rewardWei: true } },
        _count: { select: { submissions: { where: { payoutStatus: { in: ["sent", "confirmed"] }, isGoldCheck: false } } } },
      },
    });
    if (!task) {
      return errorResponse("task_not_found", 404, { walletAddress, taskId });
    }

    if (!task.isGold) {
      const responseTarget = task.responseTarget ?? task.campaign?.defaultResponseTarget ?? null;
      if (responseTarget !== null && task._count.submissions >= responseTarget) {
        return errorResponse("response_target_reached", 409, { walletAddress, taskId, responseTarget, paid: task._count.submissions });
      }
    }

    // Prevent retest users from submitting non-gold tasks
    if (isInRetest(user.isBanned, user.bannedUntil, user.banCount) && !task.isGold) {
      return errorResponse("invalid_task", 400, { walletAddress, taskId, reason: "retest_requires_gold_task" });
    }

    if (task.isGold) {
      const correct = choice === task.goldAnswer;
      const inRetest = isInRetest(user.isBanned, user.bannedUntil, user.banCount);

      if (inRetest) {
        const retestStart = user.bannedUntil!;

        await prisma.$transaction(async (tx) => {
          await tx.submission.create({
            data: {
              walletAddress,
              taskId,
              choice,
              reason: reason.trim(),
              isGoldCheck: true,
              goldPassed: correct,
              payoutAmountWei: 0n,
              payoutStatus: "skipped",
            },
          });
          await tx.user.update({
            where: { walletAddress },
            data: {
              goldAttempted: { increment: 1 },
              ...(correct ? { goldCorrect: { increment: 1 } } : {}),
            },
          });
        });

        const retestCount = await prisma.submission.count({
          where: { walletAddress, isGoldCheck: true, createdAt: { gte: retestStart } },
        });

        if (retestCount >= RETEST_GOLD_COUNT) {
          const retestGoldSubs = await prisma.submission.findMany({
            where: { walletAddress, isGoldCheck: true, createdAt: { gte: retestStart } },
            select: { goldPassed: true },
            orderBy: { createdAt: "desc" },
            take: RETEST_GOLD_COUNT,
          });
          const passed = retestGoldSubs.filter((s) => s.goldPassed).length;
          const accuracy = passed / retestGoldSubs.length;

          if (accuracy >= RETEST_PASS_THRESHOLD) {
            await prisma.user.update({
              where: { walletAddress },
              data: { isBanned: false, bannedAt: null, bannedReason: null, bannedUntil: null },
            });
            console.warn("[submit] retest_passed", { walletAddress, accuracy, passed, total: retestGoldSubs.length });
          } else {
            const refreshed = await prisma.user.findUniqueOrThrow({ where: { walletAddress } });
            const next = computeCooldownBan(refreshed.banCount, refreshed.lastBanAt);
            await prisma.user.update({
              where: { walletAddress },
              data: {
                isBanned: true,
                bannedAt: new Date(),
                bannedReason: next.reason,
                banCount: next.banCount,
                bannedUntil: next.bannedUntil.getTime() === 0 ? null : next.bannedUntil,
                lastBanAt: new Date(),
              },
            });
            console.warn("[submit] retest_failed", { walletAddress, accuracy, passed, total: retestGoldSubs.length, escalatedTo: next.banCount });
          }
        }

        return NextResponse.json({ paid: false, reason: "quality_check_failed" });
      }

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
            data: {
              goldAttempted: { increment: 1 },
              lastSubmissionAt: new Date(),
            },
          });
        });

        const refreshed = await prisma.user.findUniqueOrThrow({
          where: { walletAddress },
        });
        const banDecision = evaluateBanRule({
          goldAttempted: refreshed.goldAttempted,
          goldCorrect: refreshed.goldCorrect,
        });
        if (banDecision.shouldBan) {
          const cooldown = computeCooldownBan(refreshed.banCount, refreshed.lastBanAt);
          await prisma.user.update({
            where: { walletAddress },
            data: {
              isBanned: true,
              bannedAt: new Date(),
              bannedReason: cooldown.reason,
              banCount: cooldown.banCount,
              bannedUntil: cooldown.bannedUntil.getTime() === 0 ? null : cooldown.bannedUntil,
              lastBanAt: new Date(),
            },
          });
          console.warn("[submit] banned_wallet", {
            walletAddress,
            goldAttempted: refreshed.goldAttempted,
            goldCorrect: refreshed.goldCorrect,
            banCount: cooldown.banCount,
            reason: cooldown.reason,
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
        await prisma.user.update({
          where: { walletAddress },
          data: { lastSubmissionAt: new Date() },
        });
        return errorResponse("left_bias_detected", 400, {
          walletAddress,
          taskId,
          sameSide,
          recent: recent.length,
        });
      }
    }

    const amount = resolveRewardWei(task.rewardWei, task.campaign?.rewardWei ?? null);
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
      const txHash = await payReward(walletAddress as `0x${string}`, amount);
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
            lastSubmissionAt: new Date(),
          },
        }),
      ]);

      if (!task.isGold && task.responseTarget != null && !task.resolvedAt) {
        const paidCount = await prisma.submission.count({
          where: { taskId, isGoldCheck: false, payoutStatus: { in: ["sent", "confirmed"] } },
        });
        if (paidCount >= task.responseTarget) {
          const iaa = await computeIAA(taskId);
          if (iaa) {
            await prisma.task.update({
              where: { id: taskId },
              data: {
                majorityAnswer: iaa.majorityAnswer,
                agreementScore: iaa.agreementScore,
                resolvedAt: new Date(),
              },
            });
          }
        }
      }

      return NextResponse.json({
        paid: true,
        txHash,
        explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
      });
    } catch (err) {
      if (err instanceof PayoutCapError) {
        await prisma.submission.update({
          where: { id: submission.id },
          data: { payoutStatus: "skipped" },
        });
        return errorResponse("daily_cap_reached", 429, {
          walletAddress,
          taskId,
          submissionId: submission.id,
          currentWei: String(err.currentWei),
          capWei: String(err.capWei),
        });
      }

      const payoutError = err instanceof Error ? err.message : String(err);
      Sentry.captureException(err, {
        extra: { walletAddress, taskId, submissionId: submission.id },
      });
      await prisma.submission.update({
        where: { id: submission.id },
        data: { payoutStatus: "failed", payoutError: payoutError.slice(0, 500) },
      });
      return errorResponse("payout_failed", 500, {
        walletAddress,
        taskId,
        submissionId: submission.id,
        err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      extra: { walletAddress, taskId },
    });
    return errorResponse("server_error", 500, {
      walletAddress,
      taskId,
      err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    });
  }
}
