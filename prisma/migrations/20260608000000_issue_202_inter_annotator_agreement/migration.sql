-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "majorityAnswer" TEXT;
ALTER TABLE "tasks" ADD COLUMN "agreementScore" DOUBLE PRECISION;
ALTER TABLE "tasks" ADD COLUMN "resolvedAt" TIMESTAMP(3);
