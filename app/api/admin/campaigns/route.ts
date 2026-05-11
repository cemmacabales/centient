import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const campaigns = await prisma.campaign.findMany({
    where: { adminUserId: session.sub },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
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

  const body = await req.json().catch(() => ({}));
  const { name, defaultResponseTarget } = body;

  if (!name || defaultResponseTarget === undefined) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const campaign = await prisma.campaign.create({
    data: {
      name,
      defaultResponseTarget: Number(defaultResponseTarget),
      adminUserId: session.sub,
    },
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    { ...campaign, taskCount: 0 },
    { status: 201 }
  );
}