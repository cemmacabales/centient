-- Add payoutRetryCount and payoutLastCheckedAt to submissions
ALTER TABLE "submissions" ADD COLUMN "payoutRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "submissions" ADD COLUMN "payoutLastCheckedAt" TIMESTAMP(3);