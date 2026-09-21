-- #27 (E2-4): record a sponsorship before it is broadcast, and let the database
-- refuse a second outstanding sponsorship for one address.
--
-- `status` is the intent lifecycle: `pending` is written before the envelope is
-- submitted, `confirmed` once Horizon accepts it, `failed` only when the result
-- is definite (the envelope can never apply). A pending row still counts against
-- the per-user cap, because its reserve may already be locked on-chain.
-- `expiresAt` is the envelope's own `maxTime`: after it, a pending envelope that
-- Horizon never reported can no longer land, so a fresh build may replace it.
--
-- Every existing row was written after a successful submit, so it is confirmed.
-- The column default stays `confirmed` so an instance still running the previous
-- release during the deploy keeps writing rows that mean what they meant.
BEGIN;

ALTER TABLE "sponsored_trustlines"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'confirmed',
    ADD COLUMN "confirmedAt" TIMESTAMP(3),
    ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "sponsored_trustlines" SET "confirmedAt" = "createdAt";

-- Refuse rather than repair: each outstanding row is a reserve liability, and
-- deleting one to satisfy the index would hide XLM the platform has locked.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "sponsored_trustlines"
        WHERE "revokedAt" IS NULL
        GROUP BY "address"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'sponsored_trustlines holds more than one outstanding row for an address; reconcile them by hand before applying this migration';
    END IF;
END $$;

-- One outstanding sponsorship per address, across all users. This is also the
-- cross-user lock that `addressSponsoredByOther` used to enforce only by reading.
CREATE UNIQUE INDEX "sponsored_trustlines_outstanding_address_key"
    ON "sponsored_trustlines"("address")
    WHERE "revokedAt" IS NULL AND "status" <> 'failed';

COMMIT;
