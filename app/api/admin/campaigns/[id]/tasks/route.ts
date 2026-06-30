import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { REWARDED_STATUSES } from "@/lib/constants";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const where = session.role === "SUPER_ADMIN" ? { id } : { id, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: { defaultResponseTarget: true, rewardUnits: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const tasks = await prisma.task.findMany({
    where: { campaignId: id },
    select: {
      id: true,
      prompt: true,
      responseTarget: true,
      rewardUnits: true,
      majorityAnswer: true,
      agreementScore: true,
      resolvedAt: true,
      _count: { select: { submissions: { where: { payoutStatus: { in: [...REWARDED_STATUSES] }, isGoldCheck: false } } } },
    },
  });

  const result = tasks.map((t) => {
    const responseTarget = t.responseTarget ?? campaign.defaultResponseTarget;
    const responseCount = t._count.submissions;
    const pct = Math.min(100, Math.floor((responseCount / responseTarget) * 100));
    const resolvedRewardUnits = t.rewardUnits ?? campaign.rewardUnits;
    const agreementPct = t.agreementScore != null ? Math.round(t.agreementScore * 100) : null;

    return {
      taskId: t.id,
      prompt: t.prompt,
      responseTarget,
      responseCount,
      pct,
      rewardUnits: resolvedRewardUnits.toString(),
      majorityAnswer: t.majorityAnswer,
      agreementScore: t.agreementScore,
      agreementPct,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
    };
  });

  return NextResponse.json(result);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const where = session.role === "SUPER_ADMIN" ? { id } : { id, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: { id: true, defaultResponseTarget: true, rewardUnits: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const { prompt, responseTarget, rewardUnits: rewardUnitsRaw } = body;

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });
  }

  const target = responseTarget !== undefined ? responseTarget : campaign.defaultResponseTarget;
  if (!Number.isInteger(target) || target < 1) {
    return NextResponse.json({ error: "invalid_response_target" }, { status: 400 });
  }

  let rewardUnits: bigint | null = null;
  if (rewardUnitsRaw !== undefined) {
    if (typeof rewardUnitsRaw !== "string" || !/^\d+$/.test(rewardUnitsRaw)) {
      return NextResponse.json({ error: "invalid_reward_units" }, { status: 400 });
    }
    rewardUnits = BigInt(rewardUnitsRaw);
  }

  const existing = await prisma.task.findUnique({
    where: { campaignId_prompt: { campaignId: id, prompt: prompt.trim() } },
  });

  if (existing) {
    return NextResponse.json({ error: "duplicate_prompt" }, { status: 409 });
  }

  const task = await prisma.task.create({
    data: {
      campaignId: id,
      prompt: prompt.trim(),
      responseA: "(add via CSV)",
      responseB: "(add via CSV)",
      responseTarget: target,
      rewardUnits,
    },
  });

  const resolvedRewardUnits = task.rewardUnits ?? campaign.rewardUnits;

  return NextResponse.json({
    taskId: task.id,
    prompt: task.prompt,
    responseTarget: task.responseTarget ?? campaign.defaultResponseTarget,
    rewardUnits: resolvedRewardUnits.toString(),
    responseCount: 0,
    pct: 0,
  }, { status: 201 });
}
