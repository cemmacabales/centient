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
    select: { defaultResponseTarget: true },
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
      _count: { select: { submissions: { where: { payoutStatus: "sent", isGoldCheck: false } } } },
    },
  });

  const result = tasks.map((t) => {
    const responseTarget = t.responseTarget ?? campaign.defaultResponseTarget;
    const responseCount = t._count.submissions;
    const pct = Math.min(100, Math.floor((responseCount / responseTarget) * 100));

    return {
      taskId: t.id,
      prompt: t.prompt,
      responseTarget,
      responseCount,
      pct,
    };
  });

  return NextResponse.json(result);
}