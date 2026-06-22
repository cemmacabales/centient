-- P3a: extend payout_jobs to support lump-sum withdrawals alongside per-submission payouts.

CREATE TYPE "PayoutJobType" AS ENUM ('SUBMISSION_PAYOUT', 'WITHDRAWAL');

ALTER TABLE "payout_jobs"
  ADD COLUMN "type" "PayoutJobType" NOT NULL DEFAULT 'SUBMISSION_PAYOUT',
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "amountWei" BIGINT,
  ADD COLUMN "destinationAddress" TEXT;

-- Withdrawals have no submission, so submissionId becomes optional.
ALTER TABLE "payout_jobs" ALTER COLUMN "submissionId" DROP NOT NULL;

ALTER TABLE "payout_jobs" ADD CONSTRAINT "payout_jobs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "payout_jobs_userId_idx" ON "payout_jobs"("userId");

-- Idempotency / one-in-flight guard: at most one queued-or-processing withdrawal
-- per user. A second concurrent withdrawal request violates this and is rejected,
-- so a user can never have two lump-sum payouts in flight at once.
CREATE UNIQUE INDEX "payout_jobs_user_inflight_withdrawal_key"
  ON "payout_jobs"("userId")
  WHERE "type" = 'WITHDRAWAL' AND "status" IN ('queued', 'processing');
