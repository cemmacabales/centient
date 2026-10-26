-- #203 (ADR-0012): the weekly board, display names and event codes. XP is never money.

-- AlterEnum
ALTER TYPE "XpKind" ADD VALUE 'EVENT_CODE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "displayNameHiddenAt" TIMESTAMP(3),
ADD COLUMN     "showOnBoard" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "event_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "stampTitle" TEXT NOT NULL,
    "stampIcon" TEXT NOT NULL,
    "startsDay" TEXT NOT NULL,
    "endsDay" TEXT NOT NULL,
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_redemptions" (
    "eventCodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_redemptions_pkey" PRIMARY KEY ("eventCodeId","userId")
);

-- CreateTable
CREATE TABLE "retired_display_names" (
    "name" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_display_names_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "board_weeks" (
    "weekKey" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_weeks_pkey" PRIMARY KEY ("weekKey")
);

-- CreateTable
CREATE TABLE "weekly_results" (
    "weekKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "xp" INTEGER NOT NULL,

    CONSTRAINT "weekly_results_pkey" PRIMARY KEY ("weekKey","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_displayName_key" ON "users"("displayName");

-- CreateIndex
CREATE UNIQUE INDEX "event_codes_code_key" ON "event_codes"("code");

-- CreateIndex
CREATE INDEX "event_redemptions_userId_idx" ON "event_redemptions"("userId");

-- CreateIndex
CREATE INDEX "weekly_results_userId_idx" ON "weekly_results"("userId");

-- AddForeignKey
ALTER TABLE "event_codes" ADD CONSTRAINT "event_codes_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_redemptions" ADD CONSTRAINT "event_redemptions_eventCodeId_fkey" FOREIGN KEY ("eventCodeId") REFERENCES "event_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_redemptions" ADD CONSTRAINT "event_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_results" ADD CONSTRAINT "weekly_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
