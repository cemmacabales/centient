import { NextRequest, NextResponse } from "next/server";
import { formatUnits } from "viem";
import prisma from "@/lib/prisma";
import { getLabelerUser } from "@/lib/labeler-auth";
import { REWARD_TOKEN_DECIMALS } from "@/lib/constants";

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const user = await getLabelerUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rawPage = req.nextUrl.searchParams.get("page");
  const page = Math.max(1, parseInt(rawPage ?? "1", 10) || 1);

  // Submissions are still keyed on walletAddress (FK repointing is P0b/#254).
  // An email-only account with no linked wallet simply has no submissions yet.
  const wallet = user.walletAddress;
  if (!wallet) {
    return NextResponse.json({
      submissions: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      totalPages: 0,
    });
  }

  const [total, rows] = await Promise.all([
    prisma.submission.count({ where: { walletAddress: wallet } }),
    prisma.submission.findMany({
      where: { walletAddress: wallet },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        taskId: true,
        choice: true,
        isGoldCheck: true,
        goldPassed: true,
        payoutAmountUnits: true,
        payoutStatus: true,
        payoutTxHash: true,
        createdAt: true,
        task: { select: { prompt: true } },
      },
    }),
  ]);

  return NextResponse.json({
    submissions: rows.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      taskPrompt: s.task.prompt,
      choice: s.choice,
      isGoldCheck: s.isGoldCheck,
      goldPassed: s.goldPassed,
      earnedDisplay: formatUnits(s.payoutAmountUnits, REWARD_TOKEN_DECIMALS),
      payoutStatus: s.payoutStatus,
      payoutTxHash: s.payoutTxHash,
      submittedAt: s.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}
