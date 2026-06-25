# Payout model — current state & no-wallet-until-withdrawal redesign

Status: **Implemented & cut over (Phase 5, #268).** The accrue-then-withdraw model
is live; the per-question on-chain payout path is **retired** for new earnings.
Sections 1–5 below are kept as the original design record; **§6 documents the live
model and the ops runbook** and is the source of truth for operations.

> **⚠️ Retired:** Section 1 describes the **legacy** per-question model. New earnings
> no longer enqueue a per-submission `PayoutJob` — approved answers accrue to an
> off-chain balance and are paid as a single lump sum at withdrawal. See §6.

## 1. How payout worked (legacy — retired)

The legacy model was **per-question, paid immediately on-chain**. Every approved
answer triggered its own on-chain transfer directly to the labeler's wallet. There
was **no** off-chain accumulation and **no** withdraw step.

### Submit path — `app/api/submit/route.ts`
1. Answer passes validation + quality / gold / anti-bias checks.
2. Reward computed: `resolveRewardWei(task.rewardWei, campaign.rewardWei)` (`:286`).
3. A `Submission` row is created with `payoutStatus: "pending"` (`:287`).
4. The **customer's prepaid campaign balance** is debited (reward + platform fee)
   via `checkAndDebit(...)` (`:303`). An empty campaign → submission `skipped`, HTTP 402.
5. A `PayoutJob` is enqueued (`status: "queued"`, `:324`).
6. Returns `{ status: "pending", submissionId }` immediately — no on-chain work on the request path.

### Payout worker — `lib/payout-worker.ts` (runs as its own service: `pnpm payout`)
1. Claims the next queued job atomically (`UPDATE ... FOR UPDATE SKIP LOCKED`).
2. `payReward(walletAddress, amount)` → an on-chain cUSD/USDC `transfer()` **straight
   to the labeler's wallet** (`:116`, impl in `lib/payout.ts`).
3. Marks the submission `sent`, stores `payoutTxHash`, and increments
   `user.totalEarnedWei` + `submissionCount` (`:124`).
4. Retries up to 3×, enforces a rolling 24h payout cap (`DAILY_PAYOUT_CAP_WEI`),
   and refunds the campaign balance on permanent failure.

The frontend polls `/api/submissions/[id]` until `payoutStatus` flips to `sent`
(`app/page.tsx:238`). A reconciler (`lib/reconciler.ts`, `pnpm reconciler`) later
confirms the on-chain receipt and moves `sent → confirmed`.

### Key facts
- **One transfer per answer**, landing in the wallet within seconds — micropayments,
  not a withdrawable balance.
- `user.totalEarnedWei` is a **historical running total of money already sent
  on-chain**. It is NOT a platform-held balance that could be withdrawn later.
- `User` is keyed by wallet: `walletAddress String @id` (`prisma/schema.prisma:11`).
  The wallet is the user's entire identity, required at **answer** time — not just
  at payout time. Even the labeler auth JWT is keyed on the wallet.

## 2. The goal

Let users **log in and answer without a wallet**. Earnings accumulate off-chain.
A MiniPay (or other) wallet is only required **once, at withdrawal/cash-out time**.

This is an **accrue-then-withdraw** model — the opposite of today's streaming
micropayments. It is a foundational change, not a config flip.

## 3. What has to change

### 3.1 Identity (no longer the wallet)
Users need an ID that isn't a wallet address — email, social, or an anonymous
device/session. Today `User.walletAddress` is the primary key and the auth subject.
Proposed:
- New surrogate id (e.g. `User.id @default(uuid())`).
- `walletAddress` becomes **nullable**, set at withdrawal time.
- Submissions key on the user id, not the wallet.
- Labeler auth JWT subject changes from wallet → user id.

### 3.2 Off-chain balance ledger
Submissions credit an accumulating balance instead of firing an immediate transfer:
- Add `User.pendingBalanceWei` (or a dedicated ledger table for auditability).
- On approved answer: credit `pendingBalanceWei` (no `PayoutJob`, no on-chain call).
- The customer-balance ledger (`lib/campaign-balance.ts`) is a good template —
  debit/credit with refund semantics already exist.

### 3.3 Withdrawal flow
A new on-demand cash-out path:
- New screen: user connects/enters a wallet, requests withdrawal.
- New endpoint: validates wallet, locks the balance, enqueues a single `PayoutJob`
  for the **accumulated** amount, zeroes/decrements `pendingBalanceWei` atomically.
- Worker pays the lump sum in one transfer (reuse existing `payReward` + retry +
  daily-cap + reconciler machinery — mostly unchanged).
- Consider a minimum-withdrawal threshold to keep gas economical.

## 4. Open questions (resolve before building)
- **Login method** without a wallet: email magic-link? social? anonymous session
  upgraded later? Affects fraud surface heavily.
- **Anti-fraud / Sybil**: today the wallet + gold-task + ban system makes a banned
  labeler costly to recreate. Wallet-less signup makes fresh identities cheap — how
  do we keep the gold/ban guarantees? (Bind ban state to something durable; gate
  withdrawal behind quality history.)
- **Wallet binding at withdrawal**: one wallet per user forever, or rebindable?
  How do we prevent a user from funneling many accounts' balances into one wallet
  to launder a ban?
- **Customer balance timing**: do we still debit the customer at answer time
  (liability accrues immediately) or only at withdrawal? Affects refunds for
  unwithdrawn balances.
- **Unwithdrawn balances**: expiry? what happens to a banned user's accrued balance?
- **Migration**: existing wallet-keyed users — backfill a surrogate id, keep their
  wallet bound.

## 5. Reusable building blocks already in place
- Background job queue + worker pattern (`PayoutJob`, `lib/payout-worker.ts`).
- On-chain transfer with nonce-safety, retries, daily cap (`lib/payout.ts`).
- Receipt reconciler (`lib/reconciler.ts`).
- Balance ledger with debit/credit/refund (`lib/campaign-balance.ts`).
- Labeler auth/JWT scaffold (`lib/labeler-auth.ts`, `/api/auth/*`).

## 6. Live model & ops runbook (P5b)

This is the **operative** description of payouts as shipped.

### 6.1 Earning (accrual) — the only path for new earnings
- `app/api/submit/route.ts` validates the answer, debits the **customer's** prepaid
  campaign balance at answer time (unchanged), then **credits the labeler's
  off-chain balance** via `creditReward(...)` (`lib/user-balance.ts`): increments
  `User.pendingBalanceWei` and writes a `CREDIT_REWARD` row to `UserBalanceLedger`.
- **No `PayoutJob` is enqueued on answer.** There is no per-question on-chain
  transfer. The submission is recorded with `payoutStatus: "accrued"`.
- A regression test (`app/api/submit/__tests__/route.test.ts` →
  "P5b regression: accrual is the only payout path") fails if an approved answer
  ever creates a `PayoutJob`, so the retired path cannot be reintroduced silently.

### 6.2 Withdrawing — the one and only on-chain payout
- `app/api/me/withdraw/route.ts` enforces the anti-fraud gates (P4a/P4b) and, on
  success, `enqueueWithdrawal(...)` (`lib/user-balance.ts`) atomically locks the
  balance, decrements `pendingBalanceWei`, writes a `WITHDRAWAL` ledger row, and
  enqueues a **single** `PayoutJob` of type **`WITHDRAWAL`** for the lump sum.
- The worker pays it and the reconciler confirms the receipt — same machinery as
  before (`payReward` + retries + daily cap + reconciler).

### 6.3 The payout worker (`pnpm payout`, `lib/payout-worker.ts`)
For **new earnings the worker only ever processes `WITHDRAWAL` lump-sum jobs.**

It still claims and processes legacy **`SUBMISSION_PAYOUT`** jobs as well — but only
to **drain pre-existing jobs** that were enqueued before the cutover. No new
`SUBMISSION_PAYOUT` jobs are created anywhere in the codebase
(`app/api/submit/route.ts` accrues instead). Once the legacy queue is empty
(`SELECT count(*) FROM payout_jobs WHERE type = 'SUBMISSION_PAYOUT' AND status IN
('queued','processing') = 0`), the `SUBMISSION_PAYOUT` branch of the worker, the
per-submission retry endpoints (`/api/admin/submissions/[id]/retry`,
`/api/cron/payout-retry`), and `lib/payout-service.ts` can be deleted outright.

### 6.4 Operator checklist
- **Monitor the legacy drain:** track the `SUBMISSION_PAYOUT` queued/processing
  count until it reaches zero; that is the signal that the legacy code in §6.3 is
  safe to remove.
- **Withdrawals stuck `queued`:** check the worker is running (`pnpm payout`) and
  the daily cap (`DAILY_PAYOUT_CAP_WEI`) has headroom.
- **Flagged withdrawals:** anti-fraud blocks surface in the admin **Flagged**
  queue (`/admin/flagged-withdrawals`, P4c) with the trigger reason.
- **Balance integrity:** `User.pendingBalanceWei` must always equal the sum of that
  user's `UserBalanceLedger` rows (`CREDIT_REWARD − WITHDRAWAL + REVERSAL`).
