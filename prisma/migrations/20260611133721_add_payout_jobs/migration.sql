-- CreateEnum
CREATE TYPE "PayoutJobStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "payout_jobs" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" "PayoutJobStatus" NOT NULL DEFAULT 'queued',
    "workerHeartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_jobs_submissionId_key" ON "payout_jobs"("submissionId");

-- CreateIndex
CREATE INDEX "payout_jobs_status_createdAt_idx" ON "payout_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payout_jobs_status_workerHeartbeatAt_idx" ON "payout_jobs"("status", "workerHeartbeatAt");

-- AddForeignKey
ALTER TABLE "payout_jobs" ADD CONSTRAINT "payout_jobs_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
