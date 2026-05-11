/*
  Warnings:

  - You are about to drop the column `lastLoginAt` on the `admin_users` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `admin_users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `admin_users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `email` to the `admin_users` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMIN');

-- DropIndex
DROP INDEX "admin_users_username_key";

-- AlterTable
ALTER TABLE "admin_users" DROP COLUMN "lastLoginAt",
DROP COLUMN "username",
ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "email" TEXT NOT NULL,
ADD COLUMN     "role" "AdminRole" NOT NULL DEFAULT 'OWNER';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "responseTarget" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ageRange" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_adminUserId_idx" ON "campaigns"("adminUserId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "tasks_campaignId_idx" ON "tasks"("campaignId");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
