import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    unban?: boolean;
  };

  if (body.action !== "resolve") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const dispute = await prisma.dispute.findUnique({ where: { id } });
  if (!dispute) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (dispute.status === "resolved") {
    return NextResponse.json({ error: "already_resolved" }, { status: 409 });
  }

  const updated = await prisma.dispute.update({
    where: { id },
    data: { status: "resolved", resolvedAt: new Date() },
  });

  if (body.unban) {
    const user = await prisma.user.findUnique({
      where: { walletAddress: dispute.walletAddress },
      select: { isBanned: true },
    });
    if (user?.isBanned) {
      await prisma.user.update({
        where: { walletAddress: dispute.walletAddress },
        data: {
          isBanned: false,
          bannedAt: null,
          bannedReason: null,
          bannedUntil: null,
          lastBanAt: null,
        },
      });
      auditLog({
        adminUserId: session.sub,
        action: "user.unban",
        targetType: "user",
        targetId: dispute.walletAddress,
        req,
        metadata: { source: "dispute_resolution", disputeId: id },
      });
    }
  }

  auditLog({
    adminUserId: session.sub,
    action: "dispute.resolve",
    targetType: "dispute",
    targetId: id,
    req,
    metadata: { walletAddress: dispute.walletAddress, unban: !!body.unban },
  });

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
  });
}
