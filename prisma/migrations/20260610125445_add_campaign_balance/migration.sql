-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'DEBIT_REWARD', 'DEBIT_FEE', 'REFUND');

-- CreateTable
CREATE TABLE "campaign_balances" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "balanceWei" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_ledger" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amountWei" BIGINT NOT NULL,
    "submissionId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_balances_campaignId_key" ON "campaign_balances"("campaignId");

-- CreateIndex
CREATE INDEX "balance_ledger_campaignId_createdAt_idx" ON "balance_ledger"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "campaign_balances" ADD CONSTRAINT "campaign_balances_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
