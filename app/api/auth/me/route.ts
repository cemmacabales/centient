import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getLabelerSession } from "@/lib/labeler-auth";

export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ authenticated: false });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, walletAddress: true, email: true, isVerified: true },
  });
  if (!user) {
    return NextResponse.json({ authenticated: false });
  }

  return NextResponse.json({
    authenticated: true,
    userId: user.id,
    // `wallet` is kept for backward compatibility with the wallet-first client.
    wallet: user.walletAddress,
    email: user.email,
    isVerified: user.isVerified,
  });
}
