-- Add retryCount and lastRetriedAt to submissions
ALTER TABLE "submissions" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "submissions" ADD COLUMN "lastRetriedAt" TIMESTAMP(3);