-- AlterTable: add rewardWei to campaigns (nullable first, backfill, then NOT NULL)
ALTER TABLE "campaigns" ADD COLUMN "rewardWei" BIGINT;

-- Backfill existing campaigns with the current env fallback: 0.05 ETH = 50000000000000000 wei
UPDATE "campaigns" SET "rewardWei" = 50000000000000000 WHERE "rewardWei" IS NULL;

-- Make the column NOT NULL after backfill
ALTER TABLE "campaigns" ALTER COLUMN "rewardWei" SET NOT NULL;

-- AlterTable: add optional rewardWei to tasks
ALTER TABLE "tasks" ADD COLUMN "rewardWei" BIGINT;
