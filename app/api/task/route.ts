import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { formatUnits } from "viem";
import {
  GOLD_TASK_RATIO,
  REWARD_TOKEN_DECIMALS,
  REWARD_TOKEN_SYMBOL,
} from "@/lib/constants";
import { resolveRewardWei } from "@/lib/payout";

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

  const done = await prisma.submission.findMany({
    where: { walletAddress: wallet },
    select: { taskId: true },
  });
  const doneIds = done.map((s) => s.taskId);

  const useGold = Math.random() < GOLD_TASK_RATIO;

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
        id: { notIn: doneIds },
      },
      include: {
        campaign: { select: { defaultResponseTarget: true, rewardWei: true } },
        _count: { select: { submissions: { where: { payoutStatus: "sent", isGoldCheck: false } } } },
      },
      orderBy: { createdAt: "asc" },
    });

    if (!task) {
      console.warn(`[task] gold pool exhausted for wallet ${wallet}, falling back to non-gold`);
    }
  }

  if (!task) {
    const nonGoldTasks = await prisma.task.findMany({
      where: {
        OR: [
          { isGold: false },
          { isGold: true, campaignId: { not: null } },
        ],
        id: { notIn: doneIds },
      },
      include: {
        campaign: { select: { defaultResponseTarget: true, rewardWei: true } },
        _count: { select: { submissions: { where: { payoutStatus: "sent", isGoldCheck: false } } } },
      },
      orderBy: { createdAt: "asc" },
    });

    for (const t of nonGoldTasks) {
      const target = computeResponseTarget(t.responseTarget, t.campaign?.defaultResponseTarget ?? null);
      if (target === null || t._count.submissions < target) {
        task = t;
        break;
      }
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