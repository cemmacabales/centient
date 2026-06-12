-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "payoutError" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "disabled" BOOLEAN NOT NULL DEFAULT false;
