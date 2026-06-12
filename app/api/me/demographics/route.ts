import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";
import prisma from "@/lib/prisma";

export async function DELETE(req: NextRequest) {
  const wallet = await getLabelerSession(req);
  if (!wallet) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await prisma.user.updateMany({
    where: { walletAddress: wallet },
    data: {
      country: null,
      gender: null,
      ageRange: null,
    },
  });

  return NextResponse.json({ success: true });
}
