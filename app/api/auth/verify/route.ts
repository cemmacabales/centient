import { NextRequest, NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import prisma from "@/lib/prisma";
import { signLabelerJWT, setLabelerSessionCookie } from "@/lib/labeler-auth";

const SIGN_IN_MESSAGE_PREFIX = "Centient Labeler Authentication\n";

export async function POST(req: NextRequest) {
  let body: { address?: string; signature?: string; nonce?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { address, signature, nonce } = body;
  const wallet = address?.toLowerCase();

  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }
  if (!signature || typeof signature !== "string" || !signature.startsWith("0x")) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  if (!nonce || typeof nonce !== "string") {
    return NextResponse.json({ error: "invalid_nonce" }, { status: 400 });
  }

  const record = await prisma.walletNonce.findFirst({
    where: { walletAddress: wallet, nonce },
  });

  if (!record) {
    return NextResponse.json({ error: "nonce_not_found" }, { status: 401 });
  }

  if (record.expiresAt < new Date()) {
    await prisma.walletNonce.delete({ where: { id: record.id } });
    return NextResponse.json({ error: "nonce_expired" }, { status: 401 });
  }

  const message = `${SIGN_IN_MESSAGE_PREFIX}Wallet: ${wallet}\nNonce: ${nonce}`;

  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase();
  } catch {
    return NextResponse.json({ error: "signature_verification_failed" }, { status: 401 });
  }

  if (recovered !== wallet) {
    return NextResponse.json({ error: "signature_mismatch" }, { status: 401 });
  }

  await prisma.walletNonce.delete({ where: { id: record.id } });

  const token = await signLabelerJWT(wallet);
  const res = NextResponse.json({ success: true });
  return setLabelerSessionCookie(res, token);
}
