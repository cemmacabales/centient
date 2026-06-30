import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { getBalanceSummary } from "@/lib/campaign-balance";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: campaignId } = await params;

  const where =
    session.role === "SUPER_ADMIN"
      ? { id: campaignId }
      : { id: campaignId, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: { id: true, rewardUnits: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const summary = await getBalanceSummary(campaignId, campaign.rewardUnits);

  const recentLedger = await prisma.balanceLedger.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      type: true,
      amountUnits: true,
      note: true,
      submissionId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    balanceUnits: summary.balanceUnits.toString(),
    estimatedSubmissionsRemaining: summary.estimatedSubmissionsRemaining,
    recentLedger: recentLedger.map((entry) => ({
      type: entry.type,
      amountUnits: entry.amountUnits.toString(),
      note: entry.note,
      submissionId: entry.submissionId,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}
