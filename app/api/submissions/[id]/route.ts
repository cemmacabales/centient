import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { formatUnits } from "viem";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { getLabelerUser } from "@/lib/labeler-auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // Primary authorization: the labeler session (JWT sub = userId) is the authority
  // for who may read this submission. Without it, anyone who knows a submission id
  // plus a (public, on-chain) wallet address could read its payout status (IDOR).
  // Submissions remain wallet-keyed, so resolve the session to its linked wallet.
  const sessionUser = await getLabelerUser(req);
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sessionWallet = sessionUser.walletAddress;
  if (!sessionWallet) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Secondary consistency check: the wallet the client is polling for must match
  // its own session. EIP-55 checksummed addresses are accepted (case-insensitive).
  const { searchParams } = new URL(req.url);
  const walletAddressParam = searchParams.get("walletAddress");
  if (
    typeof walletAddressParam !== "string" ||
    !/^0x[a-fA-F0-9]{40}$/.test(walletAddressParam) ||
    walletAddressParam.toLowerCase() !== sessionWallet.toLowerCase()
  ) {
    return NextResponse.json({ error: "invalid_wallet_param" }, { status: 400 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      payoutStatus: true,
      payoutTxHash: true,
      payoutAmountUnits: true,
      walletAddress: true,
      taskId: true,
      createdAt: true,
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (submission.walletAddress.toLowerCase() !== sessionWallet.toLowerCase()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    id: submission.id,
    payoutStatus: submission.payoutStatus,
    payoutTxHash: submission.payoutTxHash,
    payoutAmount: formatUnits(submission.payoutAmountUnits, REWARD_TOKEN_DECIMALS),
    payoutSymbol: REWARD_TOKEN_SYMBOL,
    walletAddress: submission.walletAddress,
    taskId: submission.taskId,
    createdAt: submission.createdAt.toISOString(),
  });
}
