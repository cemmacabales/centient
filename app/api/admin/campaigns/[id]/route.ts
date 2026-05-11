import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const campaign = await prisma.campaign.findFirst({
    where: { id, adminUserId: session.sub },
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