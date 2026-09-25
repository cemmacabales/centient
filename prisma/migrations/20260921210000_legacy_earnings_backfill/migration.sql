-- #39 (ADR-0007): "Total earned" reads totalEarnedUnits, which only an on-chain
-- payout ever raised; submissionCount likewise. Answers accrued under
-- accumulate-then-withdraw credited pendingBalanceUnits alone, so add each user's
-- accrued sum to their earnings and accrued count to their answers, once. The
-- owed balance itself is left exactly as it is.

-- What was added, per user. Its primary key is what stops a second run adding
-- the same sum again.
CREATE TABLE IF NOT EXISTS "legacy_earnings_backfill" (
    "userId" TEXT NOT NULL,
    "amountUnits" BIGINT NOT NULL,
    "accruedCount" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_earnings_backfill_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "legacy_earnings_backfill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Only users recorded by this statement are credited, so a re-run is a no-op.
WITH "accrued" AS (
    SELECT "userId", SUM("payoutAmountUnits")::BIGINT AS "amountUnits", COUNT(*)::INTEGER AS "accruedCount"
    FROM "submissions"
    WHERE "payoutStatus" = 'accrued'
    GROUP BY "userId"
), "recorded" AS (
    INSERT INTO "legacy_earnings_backfill" ("userId", "amountUnits", "accruedCount")
    SELECT "userId", "amountUnits", "accruedCount" FROM "accrued" WHERE "amountUnits" > 0
    ON CONFLICT ("userId") DO NOTHING
    RETURNING "userId", "amountUnits", "accruedCount"
)
UPDATE "users" AS "u"
SET "totalEarnedUnits" = "u"."totalEarnedUnits" + "recorded"."amountUnits",
    "submissionCount" = "u"."submissionCount" + "recorded"."accruedCount"
FROM "recorded"
WHERE "u"."id" = "recorded"."userId";
