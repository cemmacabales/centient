import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";
import { creditBalance, getBalanceSummary } from "@/lib/campaign-balance";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: campaignId } = await params;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, rewardStroops: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { amountStroops: amountStroopsRaw, note } = (body ?? {}) as {
    amountStroops?: unknown;
    note?: unknown;
  };

  if (typeof amountStroopsRaw !== "string" || !/^[1-9]\d*$/.test(amountStroopsRaw)) {
    return NextResponse.json({ error: "invalid_amount_stroops" }, { status: 400 });
  }
  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return NextResponse.json({ error: "invalid_note" }, { status: 400 });
  }

  const amountStroops = BigInt(amountStroopsRaw);
  const newBalanceStroops = await creditBalance(campaignId, amountStroops, note as string | undefined);
  const summary = await getBalanceSummary(campaignId, campaign.rewardStroops);

  await auditLog({
    adminUserId: session.sub,
    action: "campaign.deposit",
    targetType: "campaign",
    targetId: campaignId,
    req,
    metadata: {
      amountStroops: amountStroopsRaw,
      note: note ?? null,
      newBalanceStroops: newBalanceStroops.toString(),
    },
  });

  return NextResponse.json({
    balanceStroops: summary.balanceStroops.toString(),
    estimatedSubmissionsRemaining: summary.estimatedSubmissionsRemaining,
  });
}
