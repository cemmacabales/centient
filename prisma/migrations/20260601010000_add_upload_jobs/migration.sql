-- CreateEnum
CREATE TYPE "UploadJobStatus" AS ENUM ('queued', 'processing', 'done', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "upload_jobs" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "status" "UploadJobStatus" NOT NULL DEFAULT 'queued',
    "totalRows" INTEGER NOT NULL,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "insertedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "chunksCommitted" INTEGER NOT NULL DEFAULT 0,
    "chunksTotal" INTEGER NOT NULL DEFAULT 0,
    "errorSamples" JSONB,
    "lastError" TEXT,
    "rawText" TEXT NOT NULL,
    "workerHeartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_jobs_status_createdAt_idx" ON "upload_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "upload_jobs_campaignId_createdAt_idx" ON "upload_jobs"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "upload_jobs_status_workerHeartbeatAt_idx" ON "upload_jobs"("status", "workerHeartbeatAt");

-- AddForeignKey
ALTER TABLE "upload_jobs" ADD CONSTRAINT "upload_jobs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_jobs" ADD CONSTRAINT "upload_jobs_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
