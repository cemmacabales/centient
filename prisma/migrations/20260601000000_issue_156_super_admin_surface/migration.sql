-- Issue #156 — Super Admin surface
-- Adds provenance for bans (system vs. operator) and a campaign pause toggle.

-- AlterTable: users
ALTER TABLE "users" ADD COLUMN "bannedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "bannedReason" TEXT;

-- AlterTable: campaigns
ALTER TABLE "campaigns" ADD COLUMN "pausedAt" TIMESTAMP(3);

-- Backfill: any user already flagged isBanned=true gets a bannedAt stamp equal
-- to their createdAt so the UI has *some* timestamp to render. New bans will
-- always set bannedAt explicitly.
UPDATE "users" SET "bannedAt" = "createdAt" WHERE "isBanned" = true AND "bannedAt" IS NULL;
