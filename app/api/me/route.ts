import { NextRequest, NextResponse } from "next/server";
import { formatUnits } from "viem";
import prisma from "@/lib/prisma";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { isInCooldown, isPermanentlyBanned } from "@/lib/admin-data";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress: wallet },
  });

  const cooldown =
    user && isInCooldown(user.isBanned, user.bannedUntil);
  const permanent =
    user && isPermanentlyBanned(user.isBanned, user.bannedUntil, user.banCount);

  return NextResponse.json({
    walletAddress: wallet,
    totalEarned: user ? formatUnits(user.totalEarnedWei, REWARD_TOKEN_DECIMALS) : "0",
    rewardSymbol: REWARD_TOKEN_SYMBOL,
    submissionCount: user?.submissionCount ?? 0,
    onboardingCompleted: user?.onboardingCompleted ?? false,
    isBanned: user?.isBanned ?? false,
    isCooldown: cooldown,
    isPermanentlyBanned: permanent,
    unbannedAt: user?.bannedUntil?.toISOString() ?? null,
    banCount: user?.banCount ?? 0,
    bannedReason: user?.bannedReason ?? null,
  });
}
