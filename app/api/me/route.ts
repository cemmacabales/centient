import { NextRequest, NextResponse } from "next/server";
import { formatUnits } from "viem";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress: wallet },
  });

  return NextResponse.json({
    walletAddress: wallet,
    totalEarnedCUSD: user ? formatUnits(user.totalEarnedWei, 18) : "0",
    submissionCount: user?.submissionCount ?? 0,
  });
}
