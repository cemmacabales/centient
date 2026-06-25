-- P4c: record withdrawals blocked by the P4a/P4b anti-fraud gates so admins have a
-- review queue with the trigger reason. The withdraw endpoint still rejects the
-- attempt synchronously; this table is the audit/review artifact.

CREATE TYPE "FlaggedWithdrawalReason" AS ENUM ('BANNED_IDENTITY', 'SHARED_WALLET', 'INELIGIBLE');
CREATE TYPE "FlaggedWithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "flagged_withdrawals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "walletAddress" TEXT,
  "reason" "FlaggedWithdrawalReason" NOT NULL,
  "detail" JSONB,
  "balanceWei" BIGINT NOT NULL DEFAULT 0,
  "status" "FlaggedWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "resolvedByAdminId" TEXT,
  "resolvedAt" TIMESTAMP,
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "flagged_withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "flagged_withdrawals_status_createdAt_idx" ON "flagged_withdrawals"("status", "createdAt");
CREATE INDEX "flagged_withdrawals_userId_idx" ON "flagged_withdrawals"("userId");
