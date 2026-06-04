import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
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

  const where = session.role === "SUPER_ADMIN" ? { id } : { id, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
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

  if (rows.length === 0) {
    auditLog({
      adminUserId: session.sub,
      action: "tasks.upload",
      targetType: "campaign",
      targetId: campaign.id,
      req,
      metadata: {
        rowCount: 0,
        inserted: 0,
        errors: parseErrors,
      },
    });

    return NextResponse.json(
      {
        inserted: 0,
        skipped: parseErrors.length,
        errors: parseErrors.slice(0, 10),
      },
      { status: 200 }
    );
  }

  const job = await prisma.uploadJob.create({
    data: {
      campaignId: campaign.id,
      adminUserId: session.sub,
      fileName: file.name,
      fileSize: file.size,
      status: "queued",
      totalRows: rows.length,
      chunksTotal: Math.ceil(rows.length / 500),
      rawText: text,
      errorSamples: parseErrors.slice(0, 10),
      errorRows: parseErrors.length,
      skippedRows: parseErrors.length,
    },
    select: { id: true, status: true, totalRows: true, createdAt: true },
  });

  auditLog({
    adminUserId: session.sub,
    action: "tasks.upload.queued",
    targetType: "campaign",
    targetId: campaign.id,
    req,
    metadata: {
      jobId: job.id,
      fileName: file.name,
      fileSize: file.size,
      totalRows: rows.length,
      parseErrors: parseErrors.length,
    },
  });

  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      totalRows: job.totalRows,
      createdAt: job.createdAt,
    },
    { status: 202 }
  );
}
