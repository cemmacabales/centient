-- CreateIndex
CREATE INDEX "submissions_payoutStatus_createdAt_idx" ON "submissions"("payoutStatus", "createdAt");

-- CreateIndex
CREATE INDEX "submissions_taskId_idx" ON "submissions"("taskId");

-- CreateIndex
CREATE INDEX "tasks_isGold_createdAt_idx" ON "tasks"("isGold", "createdAt");
