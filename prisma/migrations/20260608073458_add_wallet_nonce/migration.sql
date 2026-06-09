-- CreateTable
CREATE TABLE "wallet_nonces" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_nonces_nonce_key" ON "wallet_nonces"("nonce");

-- CreateIndex
CREATE INDEX "wallet_nonces_walletAddress_idx" ON "wallet_nonces"("walletAddress");

-- CreateIndex
CREATE INDEX "wallet_nonces_expiresAt_idx" ON "wallet_nonces"("expiresAt");
