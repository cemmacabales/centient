-- P0a — split User identity from payout target + off-chain balance ledger (schema only).
-- Issue #253; spec docs/superpowers/specs/2026-06-16-payout-accumulate-then-withdraw-design.md (§5).
-- No FK repointing here: Submission/Dispute stay keyed on walletAddress. That data move is P0b (#254).

-- 1. The submissions FK currently depends on the users primary key (walletAddress).
--    Drop it so the primary key can move to the new surrogate id; it is re-added below
--    against the unique constraint on walletAddress.
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_walletAddress_fkey";

-- 2. users: add a surrogate id, backfill existing rows, and make it the primary key.
--    gen_random_uuid() is built into PostgreSQL 13+; @default(uuid()) is generated client-side,
--    so the column intentionally keeps no database-level default after backfill.
ALTER TABLE "users" ADD COLUMN "id" TEXT;
UPDATE "users" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;
ALTER TABLE "users" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "users" DROP CONSTRAINT "users_pkey";
ALTER TABLE "users" ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

-- 3. users: walletAddress is now a nullable, unique payout target — no longer identity.
ALTER TABLE "users" ALTER COLUMN "walletAddress" DROP NOT NULL;

-- 4. users: new account + off-chain balance columns.
ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "users" ADD COLUMN "pendingBalanceWei" BIGINT NOT NULL DEFAULT 0;

-- 5. Unique indexes for the relaxed/added identity columns.
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- 6. Re-add the submissions FK, now backed by the unique walletAddress constraint.
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "users"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Off-chain user balance ledger — mirrors balance_ledger.
CREATE TYPE "UserLedgerType" AS ENUM ('CREDIT_REWARD', 'WITHDRAWAL', 'REVERSAL');

CREATE TABLE "user_balance_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "UserLedgerType" NOT NULL,
    "amountWei" BIGINT NOT NULL,
    "submissionId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_balance_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_balance_ledger_userId_createdAt_idx" ON "user_balance_ledger"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "user_balance_ledger" ADD CONSTRAINT "user_balance_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
