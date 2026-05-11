import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

type ExportFormat = "json" | "csv" | "txt";

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
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

  const format = (req.nextUrl.searchParams.get("format") ?? "json") as ExportFormat;
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

  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    const headers = [
      "id", "prompt", "chosen", "rejected", "category", "chosen_side",
      "reason", "model_chosen", "model_rejected", "labeler", "tx_hash", "created_at",
    ];
    const rows = records.map((s) => {
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
        "X-Total-Records": String(records.length),
      },
    });
  }

  if (format === "txt") {
    const sections = records.map((s, i) => {
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
        "X-Total-Records": String(records.length),
      },
    });
  }

  // JSON (default)
  const lines = records.map((s) => {
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
    });
  });

  const jsonl = lines.join("\n");

  return new NextResponse(jsonl, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="centient_${dateStr}.jsonl"`,
      "X-Total-Records": String(records.length),
    },
  });
}