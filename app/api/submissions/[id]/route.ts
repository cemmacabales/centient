import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { formatUnits } from "viem";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const walletAddressParam = searchParams.get("walletAddress");

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  if (typeof walletAddressParam !== "string" || !/^0x[a-f0-9]{40}$/.test(walletAddressParam)) {
    return NextResponse.json({ error: "invalid_wallet_param" }, { status: 400 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      payoutStatus: true,
      payoutTxHash: true,
      payoutAmountWei: true,
      walletAddress: true,
      taskId: true,
      createdAt: true,
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (submission.walletAddress.toLowerCase() !== walletAddressParam.toLowerCase()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    id: submission.id,
    payoutStatus: submission.payoutStatus,
    payoutTxHash: submission.payoutTxHash,
    payoutAmount: formatUnits(submission.payoutAmountWei, REWARD_TOKEN_DECIMALS),
    payoutSymbol: REWARD_TOKEN_SYMBOL,
    walletAddress: submission.walletAddress,
    taskId: submission.taskId,
    createdAt: submission.createdAt.toISOString(),
  });
}