-- CreateTable
CREATE TABLE "users" (
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalEarnedWei" BIGINT NOT NULL DEFAULT 0,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "goldCorrect" INTEGER NOT NULL DEFAULT 0,
    "goldAttempted" INTEGER NOT NULL DEFAULT 0,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "responseA" TEXT NOT NULL,
    "responseB" TEXT NOT NULL,
    "modelA" TEXT,
    "modelB" TEXT,
    "category" TEXT,
    "isGold" BOOLEAN NOT NULL DEFAULT false,
    "goldAnswer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "choice" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "isGoldCheck" BOOLEAN NOT NULL DEFAULT false,
    "goldPassed" BOOLEAN,
    "payoutAmountWei" BIGINT NOT NULL,
    "payoutTxHash" TEXT,
    "payoutStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_isGold_idx" ON "tasks"("isGold");

-- CreateIndex
CREATE INDEX "submissions_walletAddress_idx" ON "submissions"("walletAddress");

-- CreateIndex
CREATE INDEX "submissions_payoutStatus_idx" ON "submissions"("payoutStatus");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_walletAddress_taskId_key" ON "submissions"("walletAddress", "taskId");

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "users"("walletAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
