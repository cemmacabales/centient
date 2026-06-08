import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.toLowerCase();
  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const nonce = randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await prisma.$transaction([
    prisma.walletNonce.deleteMany({
      where: { walletAddress: address, expiresAt: { gt: new Date() } },
    }),
    prisma.walletNonce.create({
      data: { walletAddress: address, nonce, expiresAt },
    }),
  ]);

  return NextResponse.json({ nonce });
}
