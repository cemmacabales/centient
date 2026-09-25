import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { resolveRewardUnits } from "@/lib/payout";
import { isSpamReason, checkReasonRepetition } from "@/lib/quality";
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
import { checkAndDebit, InsufficientBalanceError } from "@/lib/campaign-balance";
import { isAnyIdentifierBanned } from "@/lib/ban-identity";
import { getLabelerSession } from "@/lib/labeler-auth";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { accountHasUsdcTrustline } from "@/lib/stellar/client";
import { REWARDED_STATUSES } from "@/lib/constants";

function errorResponse(code: string, status: number, context: Record<string, unknown> = {}) {
  console.error(`[submit] ${code}`, context);
  Sentry.captureMessage(`[submit] ${code}`, {
    level: status >= 500 ? "error" : "warning",
    extra: context,
  });
  return NextResponse.json({ error: code }, { status });
}

/**
 * Record one answer from the signed-in contributor and, if it is accepted,
 * create its payout intent.
 *
 * Every guard runs before any write that could be paid: spam, repetition, rate
 * limit, a bound Stellar wallet, bans, a duplicate answer, the task and its
 * response target, retest, gold checks, and left/right bias. A rejected answer
 * is recorded `skipped` with no amount, or not at all.
 *
 * An accepted answer is written `pending` with its reward, together with its
 * campaign debit (when the task has a campaign) and one `SUBMISSION_PAYOUT` job,
 * in a single transaction: all three exist or none do (#37). The payout worker
 * broadcasts it through the co-signer out of band, so the response says
 * `pending`, never paid. A passed gold check earns nothing and says so only
 * after the answer, so nothing before it tells a gold task apart.
 */
export async function POST(req: NextRequest) {
  // ST-5d: identity is the session (userId), not a `0x` wallet in the body. #30:
  // the account must hold a bound wallet to answer; it is checked after the user
  // is loaded.
  const userId = await getLabelerSession(req);
  if (!userId) {
    return errorResponse("unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_body", 400);
  }

  const { taskId, choice, reason } =
    (body ?? {}) as {
      taskId?: string;
      choice?: string;
      reason?: string;
    };

  if (typeof taskId !== "string" || !taskId) {
    return errorResponse("invalid_task", 400, { userId, taskId });
  }
  if (choice !== "A" && choice !== "B") {
    return errorResponse("invalid_choice", 400, { userId, taskId, choice });
  }

  if (typeof reason !== "string" || isSpamReason(reason) || !validateReason(reason)) {
    return errorResponse("invalid_reason", 400, { userId, taskId });
  }

  const repetitionCheck = await checkReasonRepetition(userId, reason);
  if (repetitionCheck.isRepetitive) {
    return errorResponse("repetitive_reason", 400, { userId, taskId });
  }

  // Rate limit keyed on the userId. Since #30 only an account with a bound
  // Stellar wallet can answer, and a bound wallet never moves between accounts,
  // so this bucket is per-address too (#36). It stays on the userId because the
  // session carries it: the throttle runs before, and guards, the user read.
  if (await checkWalletRateLimit(userId)) {
    return errorResponse("rate_limited", 429, { userId });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return errorResponse("unauthorized", 401, { userId });
    }
    // #30: the bound wallet is the account and its payout destination. An account
    // made by email before wallet sign-in binds one before it can earn; a legacy
    // EVM `0x…` value can never receive USDC, so it counts as no wallet. 409, not
    // 403: the client reads a 403 here as a ban.
    if (!user.walletAddress || !isValidStellarAddress(user.walletAddress)) {
      return errorResponse("wallet_required", 409, { userId });
    }
    const walletAddress = user.walletAddress;

    // #36: an identity banned on any of its identifiers earns nothing, checked
    // before any write. The admin flagged-withdrawal ban writes these rows with
    // no `bannedUntil`, which the cooldown checks below do not read as a ban.
    // Same 403 `banned` the client already shows; which identifier matched is
    // logged by type only, never its value.
    const identityBan = await isAnyIdentifierBanned(user.email, walletAddress, userId);
    if (identityBan) {
      return errorResponse("banned", 403, { userId, identifierType: identityBan.bannedIdentifierType });
    }

    if (isPermanentlyBanned(user.isBanned, user.bannedUntil, user.banCount)) {
      return errorResponse("banned", 403, { userId, permanent: true });
    }
    if (isInCooldown(user.isBanned, user.bannedUntil)) {
      return errorResponse("banned", 403, {
        userId,
        unbannedAt: user.bannedUntil?.toISOString(),
      });
    }

    const existing = await prisma.submission.findUnique({
      where: { userId_taskId: { userId, taskId } },
    });
    if (existing) {
      return errorResponse("already_submitted", 409, { userId, taskId });
    }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        campaign: { select: { defaultResponseTarget: true, rewardUnits: true } },
        _count: { select: { submissions: { where: { payoutStatus: { in: [...REWARDED_STATUSES] }, isGoldCheck: false } } } },
      },
    });
    if (!task) {
      return errorResponse("task_not_found", 404, { userId, taskId });
    }

    if (!task.isGold) {
      const responseTarget = task.responseTarget ?? task.campaign?.defaultResponseTarget ?? null;
      if (responseTarget !== null && task._count.submissions >= responseTarget) {
        return errorResponse("response_target_reached", 409, { userId, taskId, responseTarget, paid: task._count.submissions });
      }
    }

    if (isInRetest(user.isBanned, user.bannedUntil, user.banCount) && !task.isGold) {
      return errorResponse("invalid_task", 400, { userId, taskId, reason: "retest_requires_gold_task" });
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
              userId,
              taskId,
              choice,
              reason: reason.trim(),
              isGoldCheck: true,
              goldPassed: correct,
              payoutAmountUnits: 0n,
              payoutStatus: "skipped",
            },
          });
          await tx.user.update({
            where: { id: userId },
            data: {
              goldAttempted: { increment: 1 },
              ...(correct ? { goldCorrect: { increment: 1 } } : {}),
            },
          });
        });

        const retestCount = await prisma.submission.count({
          where: { userId, isGoldCheck: true, createdAt: { gte: retestStart } },
        });

        if (retestCount >= RETEST_GOLD_COUNT) {
          const retestGoldSubs = await prisma.submission.findMany({
            where: { userId, isGoldCheck: true, createdAt: { gte: retestStart } },
            select: { goldPassed: true },
            orderBy: { createdAt: "desc" },
            take: RETEST_GOLD_COUNT,
          });
          const passed = retestGoldSubs.filter((s) => s.goldPassed).length;
          const accuracy = passed / retestGoldSubs.length;

          if (accuracy >= RETEST_PASS_THRESHOLD) {
            await prisma.user.update({
              where: { id: userId },
              data: { isBanned: false, bannedAt: null, bannedReason: null, bannedUntil: null },
            });
            console.warn("[submit] retest_passed", { userId });
          } else {
            const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
            const next = computeCooldownBan(refreshed.banCount, refreshed.lastBanAt);
            await prisma.user.update({
              where: { id: userId },
              data: {
                isBanned: true,
                bannedAt: new Date(),
                bannedReason: next.reason,
                banCount: next.banCount,
                bannedUntil: next.bannedUntil.getTime() === 0 ? null : next.bannedUntil,
                lastBanAt: new Date(),
              },
            });
            console.warn("[submit] retest_failed", { userId, escalatedTo: next.banCount });
          }
        }

        // Answer for this question, not the retest as a whole: a correct answer
        // said "failed" (found in #37, QA OQ-10), which is untrue even though it
        // was recorded as passed and counts toward lifting the ban.
        return NextResponse.json({
          paid: false,
          reason: correct ? "quality_check_passed" : "quality_check_failed",
        });
      }

      if (!correct) {
        await prisma.$transaction(async (tx) => {
          await tx.submission.create({
            data: {
              walletAddress,
              userId,
              taskId,
              choice,
              reason: reason.trim(),
              isGoldCheck: true,
              goldPassed: false,
              payoutAmountUnits: 0n,
              payoutStatus: "skipped",
            },
          });
          await tx.user.update({
            where: { id: userId },
            data: {
              goldAttempted: { increment: 1 },
              lastSubmissionAt: new Date(),
            },
          });
        });

        const refreshed = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
        });
        const banDecision = evaluateBanRule({
          goldAttempted: refreshed.goldAttempted,
          goldCorrect: refreshed.goldCorrect,
        });
        if (banDecision.shouldBan) {
          const cooldown = computeCooldownBan(refreshed.banCount, refreshed.lastBanAt);
          await prisma.user.update({
            where: { id: userId },
            data: {
              isBanned: true,
              bannedAt: new Date(),
              bannedReason: cooldown.reason,
              banCount: cooldown.banCount,
              bannedUntil: cooldown.bannedUntil.getTime() === 0 ? null : cooldown.bannedUntil,
              lastBanAt: new Date(),
            },
          });
          console.warn("[submit] banned_user", {
            userId,
            banCount: cooldown.banCount,
            reason: cooldown.reason,
          });
        }

        return NextResponse.json({ paid: false, reason: "quality_check_failed" });
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          goldCorrect: { increment: 1 },
          goldAttempted: { increment: 1 },
        },
      });
    }

    const recent = await prisma.submission.findMany({
      where: { userId },
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
            userId,
            taskId,
            choice,
            reason: reason.trim(),
            isGoldCheck: task.isGold,
            payoutAmountUnits: 0n,
            payoutStatus: "skipped",
          },
        });
        await prisma.user.update({
          where: { id: userId },
          data: { lastSubmissionAt: new Date() },
        });
        // #36: no `sameSide`/`recent` — they say how close the account is to the line.
        return errorResponse("left_bias_detected", 400, { userId, taskId });
      }
    }

    const answer = {
      walletAddress,
      userId,
      taskId,
      choice,
      reason: reason.trim(),
      isGoldCheck: task.isGold,
    };

    // A passed gold check earns nothing now that a reward moves money on-chain
    // (#37): no campaign funds it. The task was served like any other, so this is
    // the first the contributor learns it was a quality check.
    if (task.isGold) {
      const gold = await prisma.$transaction(async (tx) => {
        const row = await tx.submission.create({
          data: { ...answer, goldPassed: true, payoutAmountUnits: 0n, payoutStatus: "skipped" },
          select: { id: true },
        });
        await tx.user.update({ where: { id: userId }, data: { lastSubmissionAt: new Date() } });
        return row;
      });
      return NextResponse.json({ paid: false, reason: "quality_check_passed", submissionId: gold.id });
    }

    const amount = resolveRewardUnits(task.rewardUnits, task.campaign?.rewardUnits ?? null);
    const campaignId = task.campaignId;

    // The wallet must be able to hold USDC before this answer is accepted.
    //
    // An accepted answer is paid on-chain at once (#37), and the address alone
    // does not say it can receive the payment: a valid `G…` with no USDC
    // trustline fails the payout non-retryably with `op_no_trust`. Accepting it
    // anyway is the trap Codex found on this PR — the row consumes
    // `@@unique([userId, taskId])`, the worker treats `op_no_trust` as permanent
    // and refunds the campaign, and the contributor can then neither resubmit
    // the answer nor ever be paid for it, even after finishing payout setup.
    //
    // So the check goes before the write, and its answer is the same
    // `payout_setup_required` the withdraw route already returns, sending the
    // contributor to the sponsored-trustline flow with the task still unanswered.
    // A Horizon that cannot be read refuses too, as a retryable 503 with nothing
    // written. Letting the answer through on an unknown would re-open the same
    // trap for exactly the wallet that has no trustline, and during a Horizon
    // outage the payout could not be broadcast anyway.
    let hasTrustline: boolean;
    try {
      hasTrustline = await accountHasUsdcTrustline(walletAddress);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: "submit-trustline", userId, taskId } });
      return errorResponse("payout_check_unavailable", 503, { userId, taskId });
    }
    if (!hasTrustline) {
      return errorResponse("payout_setup_required", 409, { userId, taskId });
    }

    // The payout intent is durable in one transaction (#36, #37): the campaign
    // debit (reward + platform fee), the `pending` row carrying the reward, and
    // its SUBMISSION_PAYOUT job. None exists without the others. A campaign-less
    // task is platform-funded and has no debit. Insufficient balance rolls all
    // three back (402) and the answer is recorded as skipped with no amount.
    //
    // The worker, not this request, broadcasts: it re-reads destination and amount
    // from this row, and so does the co-signer before it signs.
    let submission: { id: string };
    try {
      submission = await prisma.$transaction(async (tx) => {
        const id = randomUUID();
        if (campaignId) await checkAndDebit(campaignId, amount, id, tx);
        const row = await tx.submission.create({
          data: { id, ...answer, payoutAmountUnits: amount, payoutStatus: "pending" },
          select: { id: true },
        });
        await tx.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: id } });
        return row;
      });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        await prisma.submission.create({
          data: { ...answer, payoutAmountUnits: 0n, payoutStatus: "skipped" },
        });
        return errorResponse("campaign_balance_insufficient", 402, {
          userId,
          taskId,
          campaignId,
          balanceUnits: String(err.balanceUnits),
          requiredUnits: String(err.requiredUnits),
        });
      }
      throw err;
    }

    // `pending` is the truth: the payout is queued, not broadcast. The account
    // sheet shows it move to sent and confirmed.
    return NextResponse.json({
      status: "pending",
      submissionId: submission.id,
    });
  } catch (err) {
    // #38: a repeated request converges. Two concurrent submits for one task can
    // both pass the `existing` check above; the second then hits
    // `@@unique([userId, taskId])`, its transaction rolls back (no debit, no row,
    // no job), and it gets the same answer a sequential duplicate does.
    if ((err as { code?: string } | null)?.code === "P2002") {
      return errorResponse("already_submitted", 409, { userId, taskId });
    }
    console.error("[submit] UNHANDLED ERROR:", err);
    Sentry.captureException(err, {
      extra: { userId, taskId },
    });
    return errorResponse("server_error", 500, {
      userId,
      taskId,
      err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    });
  }
}
