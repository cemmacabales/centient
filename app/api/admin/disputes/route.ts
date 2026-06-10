import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

export async function GET(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const rawStatus = req.nextUrl.searchParams.get("status") ?? "open";
  const status = rawStatus === "resolved" ? "resolved" : "open";

  const disputes = await prisma.dispute.findMany({
    where: { status },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    disputes: disputes.map((d) => ({
      id: d.id,
      walletAddress: d.walletAddress,
      reason: d.reason,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    })),
  });
}
