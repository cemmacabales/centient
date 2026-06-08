ALTER TABLE "submissions" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "submissions" ADD COLUMN "lastRetriedAt" TIMESTAMP(3);

CREATE INDEX "submissions_payoutStatus_retryCount_idx" ON "submissions"("payoutStatus", "retryCount");
CREATE INDEX "submissions_lastRetriedAt_idx" ON "submissions"("lastRetriedAt");
