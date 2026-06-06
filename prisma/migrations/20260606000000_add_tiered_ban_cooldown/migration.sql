-- Adds tiered-ban cooldown fields: banCount, bannedUntil, lastBanAt.
-- Replaces permanent-first-time-ban with escalating cooldowns
-- (24h Tier 1 → 72h Tier 2 → permanent Tier 3).

ALTER TABLE "users" ADD COLUMN "banCount"    INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "bannedUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "lastBanAt"   TIMESTAMP(3);

-- Backfill: any user already flagged isBanned=true gets
-- banCount=3 (permanent) so existing bans stay permanent
-- until manually unbanned by an admin.
UPDATE "users" SET "banCount" = 3 WHERE "isBanned" = true AND "banCount" = 0;
