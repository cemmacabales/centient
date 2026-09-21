-- Wallet sign-in (#25) shares wallet_nonces with the payout-address link flow.
--
-- `action` separates the two. Existing rows are all link challenges, so the
-- default keeps every outstanding one valid through the deploy.
-- `networkPassphrase` and `issuedAt` let the verifier rebuild a sign-in
-- challenge's exact signed text from the row alone, never from anything the
-- client sends back.
BEGIN;

ALTER TABLE "wallet_nonces"
    ADD COLUMN "action" TEXT NOT NULL DEFAULT 'link-payout-address',
    ADD COLUMN "networkPassphrase" TEXT,
    ADD COLUMN "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows all become link challenges. Keep only the newest row for each
-- wallet/action pair before installing the database-level issuance invariant.
DELETE FROM "wallet_nonces"
WHERE "id" IN (
    SELECT "id"
    FROM (
        SELECT
            "id",
            ROW_NUMBER() OVER (
                PARTITION BY "walletAddress", "action"
                ORDER BY "createdAt" DESC, "id" DESC
            ) AS "duplicateRank"
        FROM "wallet_nonces"
    ) AS "ranked"
    WHERE "duplicateRank" > 1
);

CREATE UNIQUE INDEX "wallet_nonces_walletAddress_action_key" ON "wallet_nonces"("walletAddress", "action");

COMMIT;
