import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

type ExportFormat = "json" | "csv" | "txt";
type SplitValue = "train" | "test" | "validation" | "all";

function hashForSplit(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function assignSplit(id: string): "train" | "test" | "validation" {
  const h = hashForSplit(id);
  const r = h % 100;
  if (r < 80) return "train";
  if (r < 90) return "test";
  return "validation";
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function GET(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const rawFormat = req.nextUrl.searchParams.get("format");
  const format: ExportFormat = (rawFormat as ExportFormat) ?? "json";
  if (!["json", "csv", "txt"].includes(format)) {
    return NextResponse.json(
      { error: "invalid_format", message: "?format must be json, csv, or txt" },
      { status: 400 }
    );
  }

  const splitParam = (req.nextUrl.searchParams.get("split") ?? "all") as SplitValue;
  if (!["train", "test", "validation", "all"].includes(splitParam)) {
    return NextResponse.json(
      { error: "invalid_split", message: "?split must be train, test, validation, or all" },
      { status: 400 }
    );
  }

  const category = req.nextUrl.searchParams.get("category");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "50000"), 50000);

  const records = await prisma.submission.findMany({
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

  const filtered = splitParam === "all"
    ? records
    : records.filter((s) => assignSplit(s.id) === splitParam);

  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    const headers = [
      "id", "prompt", "chosen", "rejected", "category", "chosen_side",
      "reason", "model_chosen", "model_rejected", "labeler", "tx_hash", "created_at",
    ];
    const rows = filtered.map((s) => {
      const chosen = s.choice === "A" ? s.task.responseA : s.task.responseB;
      const rejected = s.choice === "A" ? s.task.responseB : s.task.responseA;
      const chosenModel = s.choice === "A" ? s.task.modelA : s.task.modelB;
      const rejectedModel = s.choice === "A" ? s.task.modelB : s.task.modelA;
      return [
        s.id,
        s.task.prompt,
        chosen,
        rejected,
        s.task.category ?? "",
        s.choice,
        s.reason,
        chosenModel ?? "",
        rejectedModel ?? "",
        s.walletAddress,
        s.payoutTxHash ?? "",
        s.createdAt.toISOString(),
      ].map(escapeCsv).join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="centient_${dateStr}.csv"`,
        "X-Total-Records": String(filtered.length),
      },
    });
  }

  if (format === "txt") {
    const sections = filtered.map((s, i) => {
      const chosen = s.choice === "A" ? s.task.responseA : s.task.responseB;
      const rejected = s.choice === "A" ? s.task.responseB : s.task.responseA;
      return `--- Record ${i + 1} ---
ID: ${s.id}
Prompt: ${s.task.prompt}
Chosen (${s.choice}): ${chosen}
Rejected: ${rejected}
Reason: ${s.reason}
Category: ${s.task.category ?? "N/A"}
Labeler: ${s.walletAddress}
Created: ${s.createdAt.toISOString()}
`;
    });
    const txt = sections.join("\n");
    return new NextResponse(txt, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": `attachment; filename="centient_${dateStr}.txt"`,
        "X-Total-Records": String(filtered.length),
      },
    });
  }

  // JSON (default)
  const lines = filtered.map((s) => {
    const chosen = s.choice === "A" ? s.task.responseA : s.task.responseB;
    const rejected = s.choice === "A" ? s.task.responseB : s.task.responseA;
    const chosenModel = s.choice === "A" ? s.task.modelA : s.task.modelB;
    const rejectedModel = s.choice === "A" ? s.task.modelB : s.task.modelA;

    return JSON.stringify({
      prompt: s.task.prompt,
      chosen,
      rejected,
      id: s.id,
      category: s.task.category ?? null,
      chosen_side: s.choice,
      reason: s.reason,
      model_chosen: chosenModel ?? null,
      model_rejected: rejectedModel ?? null,
      labeler: s.walletAddress,
      tx_hash: s.payoutTxHash ?? null,
      created_at: s.createdAt.toISOString(),
      split: assignSplit(s.id),
    });
  });

  const jsonl = lines.join("\n");

  return new NextResponse(jsonl, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="centient_${dateStr}.jsonl"`,
      "X-Total-Records": String(filtered.length),
    },
  });
}
