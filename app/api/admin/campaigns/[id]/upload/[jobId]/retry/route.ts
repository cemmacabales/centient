import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id, jobId } = await params;

  const where =
    session.role === "SUPER_ADMIN"
      ? { id: jobId, campaignId: id }
      : { id: jobId, campaignId: id, adminUserId: session.sub };

  const job = await prisma.uploadJob.findFirst({ where });
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (job.status !== "failed" && job.status !== "cancelled") {
    return NextResponse.json(
      {
        error: "not_retryable",
        message: `Job is in '${job.status}' state; only failed or cancelled jobs can be retried`,
      },
      { status: 409 }
    );
  }

  const updated = await prisma.uploadJob.update({
    where: { id: job.id },
    data: {
      status: "queued",
      processedRows: 0,
      upsertedRows: 0,
      skippedRows: 0,
      errorRows: 0,
      chunksCommitted: 0,
      lastError: null,
      startedAt: null,
      completedAt: null,
      workerHeartbeatAt: null,
    },
    select: { id: true, status: true, totalRows: true },
  });

  auditLog({
    adminUserId: session.sub,
    action: "tasks.upload.retry",
    targetType: "campaign",
    targetId: job.campaignId,
    req,
    metadata: {
      jobId: job.id,
      fileName: job.fileName,
      totalRows: job.totalRows,
    },
  });

  return NextResponse.json(updated);
}
