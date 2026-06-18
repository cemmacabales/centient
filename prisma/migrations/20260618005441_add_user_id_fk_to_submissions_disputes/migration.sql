ALTER TABLE "submissions" ADD COLUMN "userId" TEXT;
ALTER TABLE "disputes"    ADD COLUMN "userId" TEXT;

INSERT INTO "users" (id, "walletAddress")
SELECT gen_random_uuid(), s."walletAddress"
FROM "submissions" s
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."walletAddress" = s."walletAddress");

INSERT INTO "users" (id, "walletAddress")
SELECT gen_random_uuid(), d."walletAddress"
FROM "disputes" d
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."walletAddress" = d."walletAddress");

UPDATE "submissions" s
SET "userId" = u.id
FROM "users" u
WHERE u."walletAddress" = s."walletAddress";

UPDATE "disputes" d
SET "userId" = u.id
FROM "users" u
WHERE u."walletAddress" = d."walletAddress";

ALTER TABLE "submissions" DROP CONSTRAINT IF EXISTS "submissions_walletAddress_fkey";

ALTER TABLE "submissions" ALTER COLUMN "userId" SET NOT NULL;

ALTER TABLE "disputes" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "submissions" ADD CONSTRAINT "submissions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "disputes" ADD CONSTRAINT "disputes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "submissions_userId_idx" ON "submissions"("userId");
CREATE INDEX "disputes_userId_idx" ON "disputes"("userId");
CREATE UNIQUE INDEX "submissions_userId_taskId_key" ON "submissions"("userId", "taskId");
