import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { randomUUID } from "crypto";
import { auditLog } from "@/lib/audit";
import { parseCSV } from "@/lib/csv-parser";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

  const firstLine = text.split(/\r?\n/)[0].toLowerCase();
  if (firstLine.includes("isgold") || firstLine.includes("goldanswer")) {
    return NextResponse.json(
      { error: "gold_columns_not_allowed" },
      { status: 400 }
    );
  }

  const { rows, errors: parseErrors } = parseCSV(text);

  const allErrors: string[] = [...parseErrors];

  if (rows.length === 0 && parseErrors.length > 0) {
    auditLog({
      adminUserId: session.sub,
      action: "tasks.upload",
      targetType: "campaign",
      targetId: campaign.id,
      req,
      metadata: {
        rowCount: 0,
        inserted: 0,
        errors: allErrors,
      },
    });

    return NextResponse.json(
      {
        inserted: 0,
        skipped: 0,
        errors: allErrors.slice(0, 10),
      },
      { status: 200 }
    );
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
      category: row.category ?? null,
      isGold: false,
      goldAnswer: null,
    },
    create: {
      id: randomUUID(),
      campaignId: campaign.id,
      prompt: row.prompt,
      responseA: row.responseA,
      responseB: row.responseB,
      responseTarget: row.responseTarget ?? campaign.defaultResponseTarget,
      category: row.category ?? null,
      isGold: false,
      goldAnswer: null,
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

  auditLog({
    adminUserId: session.sub,
    action: "tasks.upload",
    targetType: "campaign",
    targetId: campaign.id,
    req,
    metadata: {
      rowCount: rows.length,
      inserted: inserted,
      errors: allErrors,
    },
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
