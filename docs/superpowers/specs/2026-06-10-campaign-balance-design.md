# Campaign Balance — Design Spec

**Issue:** #204 — monetization: prepaid customer wallet  
**Date:** 2026-06-10  
**Status:** Approved, pending implementation

---

## Problem

No mechanism exists for customers to pre-fund campaigns or for the platform to capture a per-label fee. The per-label markup model (customer pays $0.20/label total: $0.05 to labeler + $0.15 platform fee) requires an off-chain prepaid balance per campaign.

---

## Decisions

| Question | Decision |
|---|---|
| `reservedWei` (in-flight reservation) | Omitted — submit flow is synchronous; DB transaction provides sufficient atomicity |
| Dashboard location | Balance card on existing `/admin/campaigns/[id]` page |
| Who can deposit | SUPER_ADMIN only (manual credit) |
| Low-balance behaviour | Warning banner only; no auto-pause |
| Fee constant | `PLATFORM_FEE_WEI` env var (no hardcoded default) |

---

## Schema

Two new Prisma models added to `prisma/schema.prisma`. No changes to existing models.

```prisma
model CampaignBalance {
  id          String   @id @default(cuid())
  campaignId  String   @unique
  campaign    Campaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)
  balanceWei  BigInt   @default(0)
  updatedAt   DateTime @updatedAt

  @@map("campaign_balances")
}

model BalanceLedger {
  id           String     @id @default(cuid())
  campaignId   String
  type         LedgerType
  amountWei    BigInt
  submissionId String?
  note         String?
  createdAt    DateTime   @default(now())

  @@index([campaignId, createdAt])
  @@map("balance_ledger")
}

enum LedgerType { DEPOSIT DEBIT_REWARD DEBIT_FEE REFUND }
```

`CampaignBalance` is upserted on first deposit or first submission attempt — no migration of existing campaign rows required. `Campaign` gets a `balance CampaignBalance?` relation field.

---

## `lib/campaign-balance.ts`

Single module, three exports:

### `InsufficientBalanceError`
Typed error class (mirrors `PayoutCapError` in `lib/payout.ts`). Carries `{ balanceWei, requiredWei }`.

### `checkAndDebit(campaignId, labelerRewardWei, submissionId)`
- Runs a `prisma.$transaction` with a raw `SELECT ... FOR UPDATE` on `campaign_balances` to prevent concurrent overdraft
- Required = `labelerRewardWei + PLATFORM_FEE_WEI`
- If `balanceWei < required`: throws `InsufficientBalanceError`
- On success:
  - Decrements `CampaignBalance.balanceWei` by `required`
  - Writes two `BalanceLedger` rows: `DEBIT_REWARD` (labelerRewardWei) and `DEBIT_FEE` (PLATFORM_FEE_WEI), both referencing `submissionId`
  - Returns updated `balanceWei`

### `creditBalance(campaignId, amountWei, note?)`
- Upserts `CampaignBalance` (creates row if campaign has no balance record yet)
- Writes a `DEPOSIT` ledger entry with optional `note`
- Returns updated `balanceWei`

### `getBalanceSummary(campaignId)`
- Returns `{ balanceWei: bigint, estimatedSubmissionsRemaining: number }`
- Estimate = `Math.floor(Number(balanceWei) / Number(rewardWei + PLATFORM_FEE_WEI))`
- `rewardWei` sourced from `Campaign.rewardWei`

### `PLATFORM_FEE_WEI`
- Read from `process.env.PLATFORM_FEE_WEI`, parsed as `BigInt`
- Throws at startup if not set (fail-fast, not silent)
- Documented in `.env.local.example`

---

## API Routes

### `POST /api/submit` — changes

Balance debit is inserted between submission creation and payout. Only applies to non-gold, campaign-linked tasks.

```
1. [existing] validate inputs, check ban/duplicate/target
2. [existing] create submission (status: "pending")
3. [new]  if (!task.isGold && task.campaignId):
            checkAndDebit(task.campaignId, amount, submission.id)
            → on InsufficientBalanceError: update submission to "skipped", return 402 { error: "campaign_balance_insufficient" }
4. [existing] payReward() — if payout fails, balance is already debited (conservative accounting)
5. [existing] update submission status + user stats
```

Gold tasks and tasks without a campaign are unaffected.

### `POST /api/admin/campaigns/[id]/deposit`

- Auth: SUPER_ADMIN only (403 for CUSTOMER role)
- Body: `{ amountWei: string, note?: string }`
- Validates `amountWei` is a positive integer string
- Calls `creditBalance(campaignId, BigInt(amountWei), note)`
- Writes `AdminAuditLog` entry: `action: "campaign.deposit"`, `targetType: "campaign"`, `metadata: { amountWei, note, newBalanceWei }`
- Returns `{ balanceWei: string, estimatedSubmissionsRemaining: number }`

### `GET /api/admin/campaigns/[id]/balance`

- Auth: CUSTOMER (own campaign only) + SUPER_ADMIN
- Returns:
  ```json
  {
    "balanceWei": "1000000000000000000",
    "estimatedSubmissionsRemaining": 5,
    "recentLedger": [
      { "type": "DEPOSIT", "amountWei": "1000000000000000000", "note": "initial top-up", "createdAt": "..." },
      ...
    ]
  }
  ```
- `recentLedger`: last 10 `BalanceLedger` entries for the campaign, ordered by `createdAt DESC`

---

## UI — Campaign Detail Page

New `BalanceCard` client component added to `CampaignDetail`. Server component fetches initial balance via `getBalanceSummary()` and passes as props. Deposit form uses client-side fetch + `router.refresh()` on success.

### Customer view
- Balance in cUSD (wei ÷ 1e18, 2 decimal places)
- Estimated submissions remaining
- Amber warning banner when `estimatedSubmissionsRemaining < 100`
- Recent ledger table: last 10 entries (type badge, cUSD amount, date, note)

### SUPER_ADMIN view
- Everything above, plus:
- "Credit Balance" form: cUSD amount input (converted to wei on submit) + optional memo
- Posts to `POST /api/admin/campaigns/[id]/deposit`
- On success: refreshes balance card without full page reload

---

## Environment

Add to `.env.local.example`:
```
# Platform fee per submission (in wei). Required — no default.
# Example: $0.15 in cUSD (18 decimals) = 150000000000000000
PLATFORM_FEE_WEI=150000000000000000
```

---

## Acceptance Criteria (from issue #204)

- [ ] `CampaignBalance` and `BalanceLedger` tables created via Prisma migration
- [ ] `POST /api/submit` checks balance and debits atomically for non-gold campaign tasks
- [ ] Submissions rejected with 402 when campaign balance is insufficient
- [ ] Customer dashboard shows balance and estimated submissions remaining on campaign detail page
- [ ] Low-balance warning shown when < 100 submissions remaining
- [ ] SUPER_ADMIN can credit a balance via deposit API + campaign detail UI
- [ ] `BalanceLedger` provides full audit trail (DEPOSIT, DEBIT_REWARD, DEBIT_FEE entries)
- [ ] `PLATFORM_FEE_WEI` env var documented in `.env.local.example`

---

## Out of Scope

- On-chain deposit verification (customer submits tx hash for auto-credit)
- Stripe / Mento payment integration
- `reservedWei` reservation for in-flight submissions
- Auto-pause when balance hits zero
- Refund flow (REFUND ledger type reserved for future use)
