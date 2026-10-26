import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

/** #202: the crowd a campaign can ask for. Expert-only campaigns come later. */
const CAMPAIGN_MIN_TIERS = [0, 1, 2] as const;

/** Labelers whose open tier reaches each option: a held tier counts as the one below. */
async function qualifyingLabelers(): Promise<Record<number, number>> {
  const rows = await prisma.$queryRaw<{ open: number; n: number }[]>`
    SELECT (u."tier" - CASE WHEN u."tierOnHold" AND u."tier" > 0 THEN 1 ELSE 0 END)::int AS open, COUNT(*)::int AS n
    FROM "users" u
    WHERE u."walletAddress" IS NOT NULL AND u."isBanned" = false
    GROUP BY 1`;
  return Object.fromEntries(
    CAMPAIGN_MIN_TIERS.map((t) => [t, rows.filter((r) => r.open >= t).reduce((sum, r) => sum + r.n, 0)]),
  );
}

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
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
      rewardUnits: true,
      csvFileName: true,
      minTier: true,
      createdAt: true,
      _count: { select: { tasks: true } },
    },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    ...campaign,
    rewardUnits: campaign.rewardUnits.toString(),
    taskCount: campaign._count.tasks,
    createdAt: campaign.createdAt.toISOString(),
    qualifyingLabelers: await qualifyingLabelers(),
  });
}

// patch
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("CUSTOMER", session);
  if (forbidden) return forbidden;

  const { id } = await params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (session.role !== "SUPER_ADMIN" && campaign.adminUserId !== session.sub) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body;
  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { name, defaultResponseTarget, rewardUnits: rewardUnitsRaw, paused, minTier } = body;
  const updateData: {
    name?: string;
    defaultResponseTarget?: number;
    rewardUnits?: bigint;
    pausedAt?: Date | null;
    minTier?: number;
  } = {};

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 200) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    updateData.name = name.trim();
  }

  if (defaultResponseTarget !== undefined) {
    if (
      typeof defaultResponseTarget !== "number" ||
      defaultResponseTarget < 1 ||
      !Number.isInteger(defaultResponseTarget)
    ) {
      return NextResponse.json({ error: "invalid_target" }, { status: 400 });
    }
    updateData.defaultResponseTarget = defaultResponseTarget;
  }

  if (rewardUnitsRaw !== undefined) {
    if (typeof rewardUnitsRaw !== "string" || !/^\d+$/.test(rewardUnitsRaw)) {
      return NextResponse.json({ error: "invalid_reward_units" }, { status: 400 });
    }
    updateData.rewardUnits = BigInt(rewardUnitsRaw);
  }

  if (paused !== undefined) {
    if (typeof paused !== "boolean") {
      return NextResponse.json({ error: "invalid_paused" }, { status: 400 });
    }
    const nextPausedAt = paused ? (campaign.pausedAt ?? new Date()) : null;
    const currentMs = campaign.pausedAt ? campaign.pausedAt.getTime() : null;
    const nextMs = nextPausedAt ? nextPausedAt.getTime() : null;
    if (nextMs !== currentMs) {
      updateData.pausedAt = nextPausedAt;
    }
  }

  if (minTier !== undefined) {
    if (!(CAMPAIGN_MIN_TIERS as readonly unknown[]).includes(minTier)) {
      return NextResponse.json({ error: "invalid_min_tier" }, { status: 400 });
    }
    if (minTier !== campaign.minTier) updateData.minTier = minTier;
  }

  const hasAnyField =
    name !== undefined ||
    defaultResponseTarget !== undefined ||
    rewardUnitsRaw !== undefined ||
    paused !== undefined ||
    minTier !== undefined;
  if (!hasAnyField) {
    return NextResponse.json({ error: "no_fields_to_update" }, { status: 400 });
  }
  if (Object.keys(updateData).length === 0) {
    return NextResponse.json(campaign, { status: 200 });
  }

  const updatedCampaign = await prisma.campaign.update({
    where: { id },
    data: updateData,
  });

  const isPauseToggle = paused !== undefined && Boolean(campaign.pausedAt) !== Boolean(updatedCampaign.pausedAt);

  auditLog({
    adminUserId: session.sub,
    action: isPauseToggle ? (paused ? "campaign.pause" : "campaign.resume") : "campaign.update",
    targetType: "campaign",
    targetId: id,
    req,
    metadata: {
      before: {
        name: campaign.name,
        defaultResponseTarget: campaign.defaultResponseTarget,
        rewardUnits: campaign.rewardUnits.toString(),
        pausedAt: campaign.pausedAt?.toISOString() ?? null,
        minTier: campaign.minTier,
      },
      after: {
        name: updatedCampaign.name,
        defaultResponseTarget: updatedCampaign.defaultResponseTarget,
        rewardUnits: updatedCampaign.rewardUnits.toString(),
        pausedAt: updatedCampaign.pausedAt?.toISOString() ?? null,
        minTier: updatedCampaign.minTier,
      }
    },
  });

  return NextResponse.json({
    ...updatedCampaign,
    rewardUnits: updatedCampaign.rewardUnits.toString(),
  }, { status: 200 });
}

// delete
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("CUSTOMER", session);
  if (forbidden) return forbidden;

  const { id } = await params;

  const campaign = await prisma.campaign.findUnique({
    where: { id },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (session.role !== "SUPER_ADMIN" && campaign.adminUserId !== session.sub) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const submissionCount = await prisma.submission.count({
    where: {
      task: {
        campaignId: id,
      },
    },
  });

  if (submissionCount > 0) {
    return NextResponse.json(
      { error: "has_submissions", count: submissionCount },
      { status: 409 }
    );
  }

  await prisma.campaign.delete({
    where: { id },
  });

  auditLog({
    adminUserId: session.sub,
    action: "campaign.delete",
    targetType: "campaign",
    targetId: id,
    req,
    metadata: {
      name: campaign.name,
      defaultResponseTarget: campaign.defaultResponseTarget,
    },
  });

  return new NextResponse(null, { status: 204 });
}
