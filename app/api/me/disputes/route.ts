import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";

export async function POST(req: NextRequest) {
  const walletSession = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(walletSession);
  if (unauthorized) return unauthorized;
  const wallet = walletSession!;

  let body: { reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10) {
    return NextResponse.json(
      { error: "reason_too_short", message: "Please describe your situation in at least 10 characters." },
      { status: 400 },
    );
  }
  if (reason.length > 2000) {
    return NextResponse.json({ error: "reason_too_long" }, { status: 400 });
  }

  const existing = await prisma.dispute.findFirst({
    where: { walletAddress: wallet, status: "open" },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "open_dispute_exists", message: "You already have an open dispute. We will review it shortly." },
      { status: 409 },
    );
  }

  const dispute = await prisma.dispute.create({
    data: { walletAddress: wallet, reason },
  });

  return NextResponse.json(
    { id: dispute.id, status: dispute.status, createdAt: dispute.createdAt.toISOString() },
    { status: 201 },
  );
}
