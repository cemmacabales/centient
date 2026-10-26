-- #201 (ADR-0010): the XP loop. XP is never money; nothing here touches the payout rail.

-- CreateEnum
CREATE TYPE "XpKind" AS ENUM ('ANSWER', 'QUALITY_CHECK', 'DAILY_GOAL', 'STREAK_MILESTONE');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "difficulty" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bestStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastGoalDay" TEXT,
ADD COLUMN     "restDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streakDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "xp" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "xp_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "XpKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "submissionId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_progress" (
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "counted" INTEGER NOT NULL DEFAULT 0,
    "goalMet" BOOLEAN NOT NULL DEFAULT false,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "restUsed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "daily_progress_pkey" PRIMARY KEY ("userId","dayKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "xp_events_dedupeKey_key" ON "xp_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "xp_events_userId_createdAt_idx" ON "xp_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "xp_events_weekKey_userId_idx" ON "xp_events"("weekKey", "userId");

-- AddForeignKey
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_progress" ADD CONSTRAINT "daily_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
