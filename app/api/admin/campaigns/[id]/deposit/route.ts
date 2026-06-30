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
    select: { id: true, rewardUnits: true },
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

  const { amountUnits: amountUnitsRaw, note } = (body ?? {}) as {
    amountUnits?: unknown;
    note?: unknown;
  };

  if (typeof amountUnitsRaw !== "string" || !/^[1-9]\d*$/.test(amountUnitsRaw)) {
    return NextResponse.json({ error: "invalid_amount_units" }, { status: 400 });
  }
  if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
    return NextResponse.json({ error: "invalid_note" }, { status: 400 });
  }

  const amountUnits = BigInt(amountUnitsRaw);
  const newBalanceUnits = await creditBalance(campaignId, amountUnits, note as string | undefined);
  const summary = await getBalanceSummary(campaignId, campaign.rewardUnits);

  await auditLog({
    adminUserId: session.sub,
    action: "campaign.deposit",
    targetType: "campaign",
    targetId: campaignId,
    req,
    metadata: {
      amountUnits: amountUnitsRaw,
      note: note ?? null,
      newBalanceUnits: newBalanceUnits.toString(),
    },
  });

  return NextResponse.json({
    balanceUnits: summary.balanceUnits.toString(),
    estimatedSubmissionsRemaining: summary.estimatedSubmissionsRemaining,
  });
}
