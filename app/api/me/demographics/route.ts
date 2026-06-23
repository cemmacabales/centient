import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";
import prisma from "@/lib/prisma";

export async function DELETE(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await prisma.user.updateMany({
    where: { id: userId },
    data: {
      country: null,
      gender: null,
      ageRange: null,
    },
  });

  return NextResponse.json({ success: true });
}
