-- ST-5d: re-key the labeler answering flow off `userId` instead of a wallet.
-- The wallet is no longer identity, so drop the wallet-keyed dedup + index and
-- relax the column to nullable (email-only answerers have no linked wallet).
-- The `(userId, taskId)` unique key and `userId` index already exist.

-- DropIndex
DROP INDEX "submissions_walletAddress_taskId_key";

-- DropIndex
DROP INDEX "submissions_walletAddress_idx";

-- AlterTable
ALTER TABLE "submissions" ALTER COLUMN "walletAddress" DROP NOT NULL;
