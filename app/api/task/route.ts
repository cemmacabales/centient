import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { GOLD_TASK_RATIO } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  const done = await prisma.submission.findMany({
    where: { walletAddress: wallet },
    select: { taskId: true },
  });
  const doneIds = done.map((s) => s.taskId);

  const useGold = Math.random() < GOLD_TASK_RATIO;

  let task = null;

  if (useGold) {
    task = await prisma.task.findFirst({
      where: {
        isGold: true,
        campaignId: null,
        goldAnswer: { not: null },
        id: { notIn: doneIds },
      },
      orderBy: { createdAt: "asc" },
    });

    if (!task) {
      console.warn(`[task] gold pool exhausted for wallet ${wallet}, falling back to non-gold`);
    }
  }

  if (!task) {
    task = await prisma.task.findFirst({
      where: { isGold: false, id: { notIn: doneIds } },
      orderBy: { createdAt: "asc" },
    });
  }

  if (!task) {
    return NextResponse.json({ task: null, message: "No more tasks available" });
  }

  return NextResponse.json({
    task: {
      id: task.id,
      prompt: task.prompt,
      responseA: task.responseA,
      responseB: task.responseB,
    },
  });
}
