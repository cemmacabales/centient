-- #29 (E2-6): track and reclaim sponsored Stellar reserves.
--
-- A reclaim is a `revokeSponsorship` the sponsor signs alone. Like a sponsorship,
-- it is recorded before it is broadcast: `reclaimTxHash` names the envelope and
-- `reclaimExpiresAt` its `maxTime`, so a run that dies after Horizon accepted it
-- is resolved by hash on the next run rather than revoked a second time.
--
-- `releasedBy` says how an outstanding sponsorship stopped being one, set in the
-- same write as `revokedAt`: `sponsor_revoke` when this platform's revocation
-- landed (its hash stays in `reclaimTxHash`), `owner` when the chain shows the
-- entries already gone or no longer sponsored — the contributor removed the
-- trustline or merged the account, and the reserve came back without us.
--
-- Every existing row predates reclaim, so all three columns start null.
BEGIN;

ALTER TABLE "sponsored_trustlines"
    ADD COLUMN "reclaimTxHash" TEXT,
    ADD COLUMN "reclaimExpiresAt" TIMESTAMP(3),
    ADD COLUMN "releasedBy" TEXT;

-- One row per executed reclaim run. `report` is the per-sponsorship disposition
-- the run acted on — skips, failures, hashes, reserve units and stroops — and
-- holds no keys, user ids or contact data. A dry run writes nothing. A run whose
-- `finishedAt` is null died mid-way; its rows' intents are what the next run
-- resolves.
CREATE TABLE "sponsorship_reclaim_runs" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "sponsor" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "reclaimedStroops" BIGINT NOT NULL DEFAULT 0,
    "report" JSONB,

    CONSTRAINT "sponsorship_reclaim_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sponsorship_reclaim_runs_startedAt_idx" ON "sponsorship_reclaim_runs"("startedAt");

COMMIT;
