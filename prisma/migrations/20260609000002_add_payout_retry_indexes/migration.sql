CREATE INDEX "submissions_payoutStatus_retryCount_idx" ON "submissions"("payoutStatus", "retryCount");
CREATE INDEX "submissions_lastRetriedAt_idx" ON "submissions"("lastRetriedAt");
