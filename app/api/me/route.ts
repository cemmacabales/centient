import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getLabelerSession } from "@/lib/labeler-auth";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";
import { isInCooldown, isPermanentlyBanned } from "@/lib/admin-data";

// ST-5d: profile is keyed on the session (userId), not a `?wallet=` param, so an
// email-only labeler with no linked wallet can read their own account. The linked
// wallet (if any) is echoed back for display only.
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cooldown = isInCooldown(user.isBanned, user.bannedUntil);
  const permanent = isPermanentlyBanned(user.isBanned, user.bannedUntil, user.banCount);

  return NextResponse.json({
    walletAddress: user.walletAddress,
    totalEarned: unitsToUsdcDisplay(user.totalEarnedUnits),
    rewardSymbol: REWARD_TOKEN_SYMBOL,
    submissionCount: user.submissionCount,
    onboardingCompleted: user.onboardingCompleted,
    isBanned: user.isBanned,
    isCooldown: cooldown,
    isPermanentlyBanned: permanent,
    unbannedAt: user.bannedUntil?.toISOString() ?? null,
    banCount: user.banCount,
    country: user.country ?? null,
    gender: user.gender ?? null,
    ageRange: user.ageRange ?? null,
    bannedReason: user.bannedReason ?? null,
  });
}
