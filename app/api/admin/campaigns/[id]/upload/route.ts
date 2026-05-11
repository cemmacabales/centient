import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

type TaskRow = {
  prompt: string;
  responseA: string;
  responseB: string;
  responseTarget?: number;
};

function parseCSV(text: string): TaskRow[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows: TaskRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });

    if (!row.prompt || !row.responsea && !row.responseb) continue;
    if (!row.prompt) {
      rows.push({ prompt: "", responseA: "", responseB: "" });
      continue;
    }

    rows.push({
      prompt: row.prompt,
      responseA: row.responsea ?? row.response_a ?? "",
      responseB: row.responseb ?? row.response_b ?? "",
      responseTarget: row.responsetarget ? parseInt(row.responsetarget, 10) : undefined,
    });
  }

  return rows.filter((r) => r.prompt && (r.responseA || r.responseB));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const campaign = await prisma.campaign.findFirst({
    where: { id, adminUserId: session.sub },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const text = await file.text();
  const rows = parseCSV(text);

  const errors: string[] = [];
  let inserted = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.prompt || (!row.responseA && !row.responseB)) {
      errors.push(`Row ${i + 2}: missing required fields`);
      continue;
    }

    try {
      await prisma.task.upsert({
        where: { id: `${campaign.id}-${i}` },
        update: {
          prompt: row.prompt,
          responseA: row.responseA,
          responseB: row.responseB,
          responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
        },
        create: {
          id: `${campaign.id}-${i}`,
          campaignId: campaign.id,
          prompt: row.prompt,
          responseA: row.responseA,
          responseB: row.responseB,
          responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
        },
      });
      inserted++;
    } catch (err) {
      errors.push(`Row ${i + 2}: failed to insert`);
    }
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { csvFileName: file.name },
  });

  return NextResponse.json({
    inserted,
    skipped: rows.length - inserted,
    errors: errors.slice(0, 10),
  });
}