import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { randomUUID } from "crypto";

type TaskRow = {
  prompt: string;
  responseA: string;
  responseB: string;
  responseTarget?: number;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;

function parseCSV(text: string): { rows: TaskRow[]; errors: string[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
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

    if (rows.length >= MAX_ROWS) {
      errors.push(`Row limit of ${MAX_ROWS} reached, truncating import`);
      break;
    }

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

    const parsedTarget = responseTargetStr ? parseInt(responseTargetStr, 10) : NaN;
    const responseTarget = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : undefined;

    rows.push({
      prompt,
      responseA,
      responseB,
      responseTarget,
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

  const forbidden = await requireRoleForRoute("CUSTOMER", session);
  if (forbidden) return forbidden;

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

  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith(".csv")) {
    return NextResponse.json({ error: "invalid_file_type" }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const text = await file.text();
  const { rows, errors: parseErrors } = parseCSV(text);

  const allErrors: string[] = [...parseErrors];

  if (rows.length === 0 && parseErrors.length > 0) {
    return NextResponse.json({
      inserted: 0,
      skipped: 0,
      errors: allErrors.slice(0, 10),
    });
  }

  const upsertArgs = rows.map((row) => ({
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
  }));

  // Chunking Implementation (#130)
  const CHUNK_SIZE = 500;
  let inserted = 0;
  let chunksCommitted = 0;
  let processingFailed = false;

  try {
    for (let i = 0; i < upsertArgs.length; i += CHUNK_SIZE) {
      const chunk = upsertArgs.slice(i, i + CHUNK_SIZE);

      // Interactive callback syntax handles custom timeouts safely
      await prisma.$transaction(
        async (tx) => {
          await Promise.all(chunk.map((args) => tx.task.upsert(args)));
        },
        { timeout: 30_000 }
      );

      chunksCommitted++;
      inserted += chunk.length;
    }
  } catch (err: any) {
    processingFailed = true;
    allErrors.push(`Transaction failed on chunk ${chunksCommitted + 1}: ${err.message || "Rolling back current batch"}`);
  }

  // Record tracked uploaded file parameters 
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { csvFileName: file.name },
  });

  const totalChunks = Math.ceil(upsertArgs.length / CHUNK_SIZE);

  return NextResponse.json(
    {
      inserted,
      skipped: rows.length - inserted + parseErrors.length,
      errors: allErrors.slice(0, 10),
      meta: {
        chunks_committed: chunksCommitted,
        chunks_failed: processingFailed ? totalChunks - chunksCommitted : 0,
        last_error: processingFailed ? allErrors[allErrors.length - 1] : null,
      },
    },
    { status: processingFailed ? 422 : 200 }
  );
}