/*
  Warnings:

  - You are about to drop the `rate_limit_buckets` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastSubmissionAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "rate_limit_buckets";
