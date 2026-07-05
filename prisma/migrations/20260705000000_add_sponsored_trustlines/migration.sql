-- #330 (ST-4e follow-up): per-user cap on outstanding platform-sponsored USDC
-- trustlines. One row per sponsored trustline; outstanding rows (revokedAt IS NULL)
-- count against the per-user cap enforced in lib/sponsored-trustline.ts. `address`
-- is a case-sensitive `G…` StrKey. `revokedAt` is set when a future reclaim job
-- frees the reserves (deferred).

-- CreateTable
CREATE TABLE "sponsored_trustlines" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sponsored_trustlines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sponsored_trustlines_userId_idx" ON "sponsored_trustlines"("userId");

-- CreateIndex
CREATE INDEX "sponsored_trustlines_address_idx" ON "sponsored_trustlines"("address");

-- AddForeignKey
ALTER TABLE "sponsored_trustlines" ADD CONSTRAINT "sponsored_trustlines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
