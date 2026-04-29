import { NextRequest, NextResponse } from "next/server";
import { formatUnits } from "viem";
import prisma from "@/lib/prisma";

const SPLITS = {
  train: 0.8,
  test: 0.1,
  validation: 0.1,
} as const;

type Split = keyof typeof SPLITS;

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!key || key !== process.env.ADMIN_SESSION_PASSWORD) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const splitParam = (req.nextUrl.searchParams.get("split") ?? "train") as Split | "all";
  const category = req.nextUrl.searchParams.get("category");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "50000"), 50000);

  const all = await prisma.submission.findMany({
    where: {
      payoutStatus: "sent",
      isGoldCheck: false,
      ...(category ? { task: { category } } : {}),
    },
    include: {
      task: {
        select: {
          prompt: true,
          responseA: true,
          responseB: true,
          category: true,
          modelA: true,
          modelB: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const trainEnd = Math.floor(all.length * SPLITS.train);
  const testEnd = trainEnd + Math.floor(all.length * SPLITS.test);

  function getSplit(idx: number): Split {
    if (idx < trainEnd) return "train";
    if (idx < testEnd) return "test";
    return "validation";
  }

  const records =
    splitParam === "all"
      ? all
      : all.filter((_, i) => getSplit(i) === splitParam);

  const lines = records.map((s, i) => {
    const chosen = s.choice === "A" ? s.task.responseA : s.task.responseB;
    const rejected = s.choice === "A" ? s.task.responseB : s.task.responseA;
    const chosenModel = s.choice === "A" ? s.task.modelA : s.task.modelB;
    const rejectedModel = s.choice === "A" ? s.task.modelB : s.task.modelA;

    return JSON.stringify({
      prompt: s.task.prompt,
      chosen,
      rejected,
      id: s.id,
      split: splitParam === "all" ? getSplit(i) : splitParam,
      category: s.task.category ?? null,
      chosen_side: s.choice,
      reason: s.reason,
      model_chosen: chosenModel ?? null,
      model_rejected: rejectedModel ?? null,
      labeler: s.walletAddress,
      tx_hash: s.payoutTxHash ?? null,
      created_at: s.createdAt.toISOString(),
    });
  });

  const jsonl = lines.join("\n");

  const filename =
    splitParam === "all"
      ? `centient_full_${new Date().toISOString().slice(0, 10)}.jsonl`
      : `${splitParam}.jsonl`;

  return new NextResponse(jsonl, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Total-Records": String(records.length),
      "X-Split": splitParam,
    },
  });
}