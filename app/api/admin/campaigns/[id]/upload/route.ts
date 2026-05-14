import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { randomUUID } from "crypto";

type TaskRow = {
  prompt: string;
  responseA: string;
  responseB: string;
  responseTarget?: number;
};

function parseCSV(text: string): { rows: TaskRow[]; errors: string[] } {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return { rows: [], errors: [] };

  const headerLine = lines[0];
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase());

  const promptIdx = headers.indexOf("prompt");
  const responseAIdx = headers.indexOf("responsea");
  const responseBIdx = headers.indexOf("responseb");
  const responseTargetIdx = headers.indexOf("responsetarget");

  if (promptIdx === -1 || responseAIdx === -1 || responseBIdx === -1) {
    return { rows: [], errors: ["CSV must have prompt, responseA, responseB columns"] };
  }

  const rows: TaskRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = parseCSVLine(line);
    const prompt = values[promptIdx]?.trim() ?? "";
    const responseA = values[responseAIdx]?.trim() ?? "";
    const responseB = values[responseBIdx]?.trim() ?? "";
    const responseTargetStr = responseTargetIdx >= 0 ? values[responseTargetIdx]?.trim() : undefined;

    if (!prompt && !responseA && !responseB) {
      errors.push(`Row ${i + 1}: empty row`);
      continue;
    }
    if (!prompt) {
      errors.push(`Row ${i + 1}: missing prompt`);
      continue;
    }
    if (!responseA) {
      errors.push(`Row ${i + 1}: missing responseA`);
      continue;
    }
    if (!responseB) {
      errors.push(`Row ${i + 1}: missing responseB`);
      continue;
    }

    rows.push({
      prompt,
      responseA,
      responseB,
      responseTarget: responseTargetStr ? parseInt(responseTargetStr, 10) : undefined,
    });
  }

  return { rows, errors };
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);

  return values;
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
  const { rows, errors: parseErrors } = parseCSV(text);

  const allErrors: string[] = [...parseErrors];
  let inserted = 0;

  for (const row of rows) {
    try {
      await prisma.task.upsert({
        where: {
          campaignId_prompt: {
            campaignId: campaign.id,
            prompt: row.prompt,
          },
        },
        update: {
          responseA: row.responseA,
          responseB: row.responseB,
          responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
        },
        create: {
          id: randomUUID(),
          campaignId: campaign.id,
          prompt: row.prompt,
          responseA: row.responseA,
          responseB: row.responseB,
          responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
        },
      });
      inserted++;
    } catch (err) {
      allErrors.push(`Row ${rows.indexOf(row) + 2}: failed to upsert`);
    }
  }

  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { csvFileName: file.name },
  });

  return NextResponse.json({
    inserted,
    skipped: rows.length - inserted + parseErrors.length,
    errors: allErrors.slice(0, 10),
  });
}