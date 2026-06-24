-- Add ban identity tables for fraud prevention: banned identities and historical identifier tracking.

CREATE TYPE "BannedIdentifierType" AS ENUM ('EMAIL', 'WALLET', 'USER_ID');
CREATE TYPE "IdentifierType" AS ENUM ('EMAIL', 'WALLET');

CREATE TABLE "banned_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identifierType" "BannedIdentifierType" NOT NULL,
  "identifierValue" TEXT NOT NULL,
  "bannedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "bannedUntil" TIMESTAMP,
  "reason" TEXT,
  PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "banned_identities_identifierType_identifierValue_key" ON "banned_identities"("identifierType", "identifierValue");
CREATE INDEX "banned_identities_identifierType_identifierValue_idx" ON "banned_identities"("identifierType", "identifierValue");

CREATE TABLE "user_identifier_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "identifierType" "IdentifierType" NOT NULL,
  "identifierValue" TEXT NOT NULL,
  "linkedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "unlinkedAt" TIMESTAMP,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "user_identifier_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_identifier_history_userId_idx" ON "user_identifier_history"("userId");
CREATE INDEX "user_identifier_history_identifierType_identifierValue_idx" ON "user_identifier_history"("identifierType", "identifierValue");
CREATE INDEX "user_identifier_history_userId_isActive_idx" ON "user_identifier_history"("userId", "isActive");