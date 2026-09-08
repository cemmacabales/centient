ALTER TABLE "payout_jobs" ADD COLUMN "broadcastAt" TIMESTAMP(3);

UPDATE "payout_jobs" AS job
SET
  "amountUnits" = COALESCE(job."amountUnits", submission."payoutAmountUnits"),
  "txHash" = COALESCE(job."txHash", submission."payoutTxHash")
FROM "submissions" AS submission
WHERE job."submissionId" = submission."id";

UPDATE "payout_jobs"
SET "broadcastAt" = COALESCE("completedAt", "updatedAt", "createdAt")
WHERE "txHash" IS NOT NULL AND "broadcastAt" IS NULL;

-- Built CONCURRENTLY: `migrate deploy` runs while the payout worker is claiming
-- jobs and writing heartbeats to this table, and an ordinary CREATE INDEX holds
-- a lock that blocks those writes for the whole build. A concurrent build that
-- fails leaves an INVALID index behind — drop it before re-running the migration.
CREATE INDEX CONCURRENTLY "payout_jobs_broadcastAt_idx" ON "payout_jobs"("broadcastAt");
CREATE INDEX CONCURRENTLY "payout_jobs_status_completedAt_idx" ON "payout_jobs"("status", "completedAt");
