import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

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
      csvFileName: true,
      createdAt: true,
      _count: { select: { tasks: true } },
    },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    ...campaign,
    taskCount: campaign._count.tasks,
    createdAt: campaign.createdAt.toISOString(),
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

  const { name, defaultResponseTarget, paused } = body;
  const updateData: {
    name?: string;
    defaultResponseTarget?: number;
    pausedAt?: Date | null;
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

  if (paused !== undefined) {
    if (typeof paused !== "boolean") {
      return NextResponse.json({ error: "invalid_paused" }, { status: 400 });
    }
    const nextPausedAt = paused ? (campaign.pausedAt ?? new Date()) : null;
    if (nextPausedAt?.getTime() !== (campaign.pausedAt?.getTime() ?? null)) {
      updateData.pausedAt = nextPausedAt;
    }
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: "no_fields_to_update" }, { status: 400 });
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
        pausedAt: campaign.pausedAt?.toISOString() ?? null,
      },
      after: {
        name: updatedCampaign.name,
        defaultResponseTarget: updatedCampaign.defaultResponseTarget,
        pausedAt: updatedCampaign.pausedAt?.toISOString() ?? null,
      }
    },
  });

  return NextResponse.json(updatedCampaign, { status: 200 });
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
