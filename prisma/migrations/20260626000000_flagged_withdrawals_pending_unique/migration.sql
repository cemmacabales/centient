-- Enforce at most one PENDING flagged withdrawal per (userId, reason).
-- This makes recordFlaggedWithdrawal's upsert atomic and prevents race-condition duplicates.
CREATE UNIQUE INDEX "flagged_withdrawals_userId_reason_pending_uniq"
  ON "flagged_withdrawals"("userId", "reason")
  WHERE "status" = 'PENDING';
