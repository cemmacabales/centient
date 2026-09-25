-- #38: record every signed submission-payout envelope before it is submitted,
-- so an unknown outcome (a process killed mid-broadcast, a Horizon timeout) is
-- settled by the envelope's hash instead of by building a second payment.

-- A job that stands down on an unsettled envelope waits until this instant
-- rather than being reclaimed at once.
ALTER TABLE "payout_jobs" ADD COLUMN "notBefore" TIMESTAMP(3);

CREATE TABLE "payout_attempts" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "envelopeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "payout_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payout_attempts_envelopeHash_key" ON "payout_attempts"("envelopeHash");
CREATE INDEX "payout_attempts_submissionId_idx" ON "payout_attempts"("submissionId");
CREATE INDEX "payout_attempts_status_expiresAt_idx" ON "payout_attempts"("status", "expiresAt");

-- At most one envelope per submission may be live. A second `open` attempt is
-- refused by the database, whatever the code above it gets wrong.
CREATE UNIQUE INDEX "payout_attempts_one_open_per_submission"
  ON "payout_attempts"("submissionId") WHERE ("status" = 'open');

ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The co-signer reads the ledger through its own read-only role (ADR-0001) and,
-- from #38, refuses to sign for a submission with an open attempt. That role
-- holds no default privileges, so it cannot see a new table until granted. The
-- role exists only where the co-signer is deployed; elsewhere this is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'centient_cosigner') THEN
    GRANT SELECT ON "payout_attempts" TO centient_cosigner;
  END IF;
END
$$;
