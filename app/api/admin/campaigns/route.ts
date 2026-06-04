import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const where = session.role === "SUPER_ADMIN" ? {} : { adminUserId: session.sub };

  const campaigns = await prisma.campaign.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
      rewardWei: true,
      createdAt: true,
      _count: {
        select: { tasks: true },
      },
    },
  });

  const result = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    defaultResponseTarget: c.defaultResponseTarget,
    rewardWei: c.rewardWei.toString(),
    taskCount: c._count.tasks,
    createdAt: c.createdAt.toISOString(),
  }));

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("CUSTOMER", session);
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const { name, defaultResponseTarget, rewardWei: rewardWeiRaw } = body;

  if (
    !name?.trim() ||
    defaultResponseTarget === undefined ||
    !Number.isInteger(Number(defaultResponseTarget)) ||
    Number(defaultResponseTarget) < 1
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const { rewardInWei } = await import("@/lib/payout");

  let rewardWei: bigint;
  if (typeof rewardWeiRaw === "string" || typeof rewardWeiRaw === "bigint") {
    rewardWei = BigInt(rewardWeiRaw);
  } else {
    rewardWei = rewardInWei();
  }

  const campaign = await prisma.campaign.create({
    data: {
      name: name.trim(),
      defaultResponseTarget: Number(defaultResponseTarget),
      rewardWei,
      adminUserId: session.sub,
    },
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
      rewardWei: true,
      createdAt: true,
    },
  });

  auditLog({
    adminUserId: session.sub,
    action: "campaign.create",
    targetType: "campaign",
    targetId: campaign.id,
    req,
    metadata: {
      name: campaign.name,
      defaultResponseTarget: campaign.defaultResponseTarget,
      rewardWei: campaign.rewardWei.toString(),
    }
  });

  return NextResponse.json(
    { ...campaign, rewardWei: campaign.rewardWei.toString(), taskCount: 0 },
    { status: 201 }
  );
}
