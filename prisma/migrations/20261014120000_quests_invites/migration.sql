-- #203 (ADR-0012): weekly quests and invites. XP is never money.

-- AlterEnum
ALTER TYPE "XpKind" ADD VALUE 'QUEST';
ALTER TYPE "XpKind" ADD VALUE 'INVITE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "inviteCode" TEXT,
ADD COLUMN     "invitedById" TEXT;

-- CreateTable
CREATE TABLE "invite_rewards" (
    "inviteeId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviterRewarded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_rewards_pkey" PRIMARY KEY ("inviteeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_inviteCode_key" ON "users"("inviteCode");

-- CreateIndex
CREATE INDEX "invite_rewards_inviterId_idx" ON "invite_rewards"("inviterId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_rewards" ADD CONSTRAINT "invite_rewards_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_rewards" ADD CONSTRAINT "invite_rewards_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
