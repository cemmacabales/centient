-- QA fixture lifecycle (#86 / B9). One row per `qa:fixtures seed`, closed out by
-- the matching reset, so a D1 evidence run can say which fixtures existed under
-- which payout references, at which SHA, and what a reset removed.
--
-- A new table with no foreign keys into the payout tables: the record has to
-- outlive the fixture rows it describes, and a cascade from a deleted submission
-- would erase exactly the audit trail the reset is required to leave behind.
CREATE TABLE "qa_fixture_runs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "gitSha" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "fixtures" JSONB NOT NULL,
    "seededCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER,
    "preservedCount" INTEGER,
    "note" TEXT,
    "seededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resetAt" TIMESTAMP(3),

    CONSTRAINT "qa_fixture_runs_pkey" PRIMARY KEY ("id")
);

-- A run id is how a reset finds its own fixtures; two runs sharing one would let
-- a reset delete another run's rows.
CREATE UNIQUE INDEX "qa_fixture_runs_runId_key" ON "qa_fixture_runs"("runId");

CREATE INDEX "qa_fixture_runs_seededAt_idx" ON "qa_fixture_runs"("seededAt");
