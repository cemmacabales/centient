-- #202 review: `submissions.retest` arrived with a default of false, so retest
-- answers written before it read as ordinary quality checks and fed the tier
-- floors, the Sharp-eye stamp and the weekly board's 80%. A retest is the first
-- 3 (RETEST_GOLD_COUNT) quality checks a labeler answers after a ban: nothing
-- else is accepted while banned. Only the latest ban is on record
-- (users.lastBanAt), so mark the first 3 checks after it.
--
-- A one-off fitted to the data at release (2 labelers ever banned, both by the
-- gold-check auto-ban, which writes the failing check before lastBanAt). It is
-- not a general rule: an admin or flagged-withdrawal ban sets lastBanAt with no
-- retest, retests before the latest ban stay unmarked, and an account unbanned
-- through a dispute (lastBanAt null) is skipped. New rows are marked as written.
WITH after_ban AS (
  SELECT
    s.id,
    row_number() OVER (PARTITION BY s."userId" ORDER BY s."createdAt", s.id) AS n
  FROM "submissions" s
  JOIN "users" u ON u.id = s."userId"
  WHERE u."banCount" > 0
    AND u."lastBanAt" IS NOT NULL
    AND s."isGoldCheck" = true
    AND s."createdAt" >= u."lastBanAt"
)
UPDATE "submissions" s
SET "retest" = true
FROM after_ban
WHERE s.id = after_ban.id
  AND after_ban.n <= 3
  AND s."retest" = false;
