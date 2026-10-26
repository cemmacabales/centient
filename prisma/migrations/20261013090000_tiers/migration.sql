-- #202 (ADR-0011): tiers, holds and stamps. A tier gates which tasks are open and never pays.

-- AlterEnum
ALTER TYPE "XpKind" ADD VALUE 'CROWD_MATCH';

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "minTier" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "labelerTier" INTEGER,
ADD COLUMN     "retest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "holdChecksPassed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tier" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tierOnHold" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_stamps" (
    "userId" TEXT NOT NULL,
    "stampId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_stamps_pkey" PRIMARY KEY ("userId","stampId")
);

-- AddForeignKey
ALTER TABLE "user_stamps" ADD CONSTRAINT "user_stamps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
