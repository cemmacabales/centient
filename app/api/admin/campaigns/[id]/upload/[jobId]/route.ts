import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(
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

  return NextResponse.json(
    {
      id: job.id,
      campaignId: job.campaignId,
      fileName: job.fileName,
      fileSize: job.fileSize,
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      upsertedRows: job.upsertedRows,
      skippedRows: job.skippedRows,
      errorRows: job.errorRows,
      chunksCommitted: job.chunksCommitted,
      chunksTotal: job.chunksTotal,
      errorSamples: job.errorSamples,
      lastError: job.lastError,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }
  );
}
