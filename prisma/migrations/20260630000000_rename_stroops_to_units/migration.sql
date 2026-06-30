-- ST-2c (#315) — rename every *Stroops money column to *Units (asset-neutral).
--
-- Pure column RENAME (BigInt type unchanged, values preserved in place). The
-- payout asset is USDC (an issued Stellar asset), so "stroops" — XLM's native
-- base unit — was a misnomer; *Units is the asset-neutral 7-dec name from
-- roadmap #289 locked-decision (3). No value/scale change: USDC is also 7-dec.

-- users
ALTER TABLE "users" RENAME COLUMN "totalEarnedStroops" TO "totalEarnedUnits";
ALTER TABLE "users" RENAME COLUMN "pendingBalanceStroops" TO "pendingBalanceUnits";

-- tasks
ALTER TABLE "tasks" RENAME COLUMN "rewardStroops" TO "rewardUnits";

-- campaigns
ALTER TABLE "campaigns" RENAME COLUMN "rewardStroops" TO "rewardUnits";

-- submissions
ALTER TABLE "submissions" RENAME COLUMN "payoutAmountStroops" TO "payoutAmountUnits";

-- payout_jobs
ALTER TABLE "payout_jobs" RENAME COLUMN "amountStroops" TO "amountUnits";

-- balance_ledger
ALTER TABLE "balance_ledger" RENAME COLUMN "amountStroops" TO "amountUnits";

-- user_balance_ledger
ALTER TABLE "user_balance_ledger" RENAME COLUMN "amountStroops" TO "amountUnits";

-- campaign_balances
ALTER TABLE "campaign_balances" RENAME COLUMN "balanceStroops" TO "balanceUnits";

-- flagged_withdrawals
ALTER TABLE "flagged_withdrawals" RENAME COLUMN "balanceStroops" TO "balanceUnits";
