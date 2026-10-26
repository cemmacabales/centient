import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";
import prisma from "@/lib/prisma";
import { readBoard } from "@/lib/gamification/leaderboard";

// #203: this week's board (board 08). Rows carry a rank, a name or null for
// "Hidden labeler", a tier and XP: no wallets, no earnings, no ids (ADR-0012).
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await readBoard(userId));
}
