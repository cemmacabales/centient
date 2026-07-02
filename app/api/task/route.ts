import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import {
  GOLD_TASK_RATIO,
  REWARD_TOKEN_SYMBOL,
  REWARDED_STATUSES,
} from "@/lib/constants";
import { resolveRewardUnits } from "@/lib/payout";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";
import { getLabelerSession } from "@/lib/labeler-auth";
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
  // ST-5d: task assignment is keyed on the session (userId), not a `?wallet=`
  // param — an email-only labeler with no linked wallet can still be served tasks.
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (isInCooldown(user.isBanned, user.bannedUntil)) {
    return NextResponse.json({
      cooldown: true,
      unbannedAt: user.bannedUntil!.toISOString(),
    });
  }

  const inRetest = isInRetest(user.isBanned, user.bannedUntil, user.banCount);

  const done = await prisma.submission.findMany({
    where: { userId },
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
    rewardUnits: bigint | null;
    campaign: { defaultResponseTarget: number; rewardUnits: bigint } | null;
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
        campaign: { select: { defaultResponseTarget: true, rewardUnits: true } },
        _count: { select: { submissions: { where: { payoutStatus: { in: [...REWARDED_STATUSES] }, isGoldCheck: false } } } },
      },
      orderBy: { createdAt: "asc" },
    });

    if (!task) {
      console.warn(`[task] gold pool exhausted for user ${userId}, falling back to non-gold`);
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
               AND s."payoutStatus" IN (${Prisma.join([...REWARDED_STATUSES])})
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
          campaign: { select: { defaultResponseTarget: true, rewardUnits: true } },
          _count: { select: { submissions: { where: { payoutStatus: { in: [...REWARDED_STATUSES] }, isGoldCheck: false } } } },
        },
      });
    }
  }

  if (!task) {
    return NextResponse.json({ task: null, message: "No more tasks available" });
  }

  const target = computeResponseTarget(task.responseTarget, task.campaign?.defaultResponseTarget ?? null);
  const submissionsRemaining = target !== null ? Math.max(0, target - task._count.submissions) : null;
  const resolvedUnits = resolveRewardUnits(task.rewardUnits, task.campaign?.rewardUnits ?? null);
  const rewardDisplay = unitsToUsdcDisplay(resolvedUnits);

  return NextResponse.json({
    task: {
      id: task.id,
      prompt: task.prompt,
      responseA: task.responseA,
      responseB: task.responseB,
      submissionsRemaining,
      rewardUnits: resolvedUnits.toString(),
      rewardDisplay,
      rewardSymbol: REWARD_TOKEN_SYMBOL,
    },
  });
}