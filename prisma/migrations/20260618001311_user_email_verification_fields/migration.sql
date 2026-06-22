-- Add email-verification columns to users, mirroring the AdminUser verification fields
-- so labeler email/password accounts can use the same verify-email flow.
ALTER TABLE "users" ADD COLUMN "isVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "verificationToken" TEXT;
ALTER TABLE "users" ADD COLUMN "verificationTokenExpires" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_verificationToken_key" ON "users"("verificationToken");
