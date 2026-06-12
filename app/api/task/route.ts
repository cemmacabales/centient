import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { formatUnits } from "viem";
import {
  GOLD_TASK_RATIO,
  REWARD_TOKEN_DECIMALS,
  REWARD_TOKEN_SYMBOL,
} from "@/lib/constants";
import { resolveRewardWei } from "@/lib/payout";
import {
  isInCooldown,
  isInRetest,
  RETEST_GOLD_COUNT,
} from "@/lib/admin-data";

function computeResponseTarget(
  taskResponseTarget: number | null,
  campaignDefaultResponseTarget: number | null,
): number | null {
  return taskResponseTarget ?? campaignDefaultResponseTarget ?? null;
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress: wallet },
  });

  if (user && isInCooldown(user.isBanned, user.bannedUntil)) {
    return NextResponse.json({
      cooldown: true,
      unbannedAt: user.bannedUntil!.toISOString(),
    });
  }

  const inRetest = user
    ? isInRetest(user.isBanned, user.bannedUntil, user.banCount)
    : false;

  const done = await prisma.submission.findMany({
    where: { walletAddress: wallet },
    select: { taskId: true },
  });
  const doneIds = done.map((s) => s.taskId);

  const useGold = inRetest || Math.random() < GOLD_TASK_RATIO;

  let task: {
    id: string;
    prompt: string;
    responseA: string;
    responseB: string;
    isGold: boolean;
    responseTarget: number | null;
    rewardWei: bigint | null;
    campaign: { defaultResponseTarget: number; rewardWei: bigint } | null;
    _count: { submissions: number };
  } | null = null;

  if (useGold) {
    task = await prisma.task.findFirst({
      where: {
        isGold: true,
        campaignId: null,
        goldAnswer: { not: null },
        disabled: false,
        id: { notIn: doneIds },
      },
      include: {
        campaign: { select: { defaultResponseTarget: true, rewardWei: true } },
        _count: { select: { submissions: { where: { payoutStatus: { in: ["sent", "confirmed"] }, isGoldCheck: false } } } },
      },
      orderBy: { createdAt: "asc" },
    });

    if (!task) {
      console.warn(`[task] gold pool exhausted for wallet ${wallet}, falling back to non-gold`);
    }
  }

  if (!task) {
    const doneIdCondition =
      doneIds.length > 0
        ? Prisma.sql`AND t.id NOT IN (${Prisma.join(doneIds)})`
        : Prisma.empty;

    const available = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id
      FROM "tasks" t
      LEFT JOIN "campaigns" c ON t."campaignId" = c.id
      WHERE
        (
          t."isGold" = false
          OR (t."isGold" = true AND t."campaignId" IS NOT NULL)
        )
        AND t."disabled" = false
        ${doneIdCondition}
        AND (
          COALESCE(t."responseTarget", c."defaultResponseTarget") IS NULL
          OR (
            SELECT COUNT(*)
            FROM "submissions" s
            WHERE s."taskId" = t.id
               AND s."payoutStatus" IN ('sent', 'confirmed')
              AND s."isGoldCheck" = false
          ) < COALESCE(t."responseTarget", c."defaultResponseTarget")
        )
      ORDER BY t."createdAt" ASC
      LIMIT 1
    `;

    if (available.length > 0) {
      task = await prisma.task.findFirst({
        where: { id: available[0].id },
        include: {
          campaign: { select: { defaultResponseTarget: true, rewardWei: true } },
          _count: { select: { submissions: { where: { payoutStatus: { in: ["sent", "confirmed"] }, isGoldCheck: false } } } },
        },
      });
    }
  }

  if (!task) {
    return NextResponse.json({ task: null, message: "No more tasks available" });
  }

  const target = computeResponseTarget(task.responseTarget, task.campaign?.defaultResponseTarget ?? null);
  const submissionsRemaining = target !== null ? Math.max(0, target - task._count.submissions) : null;
  const resolvedWei = resolveRewardWei(task.rewardWei, task.campaign?.rewardWei ?? null);
  const rewardDisplay = formatUnits(resolvedWei, REWARD_TOKEN_DECIMALS);

  return NextResponse.json({
    task: {
      id: task.id,
      prompt: task.prompt,
      responseA: task.responseA,
      responseB: task.responseB,
      submissionsRemaining,
      rewardWei: resolvedWei.toString(),
      rewardDisplay,
      rewardSymbol: REWARD_TOKEN_SYMBOL,
    },
  });
}