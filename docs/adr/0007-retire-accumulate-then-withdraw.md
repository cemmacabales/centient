# ADR-0007: Retire accumulate-then-withdraw; sunset the legacy balances

- **Status:** Accepted — 2026-09-21
- **Scope:** Deliverable 3 (instant wallet-native payout): what happens to the off-chain balance model now that every accepted answer is paid on-chain.
- **Relates to:** [#39](https://github.com/webnxt-2030/Centient/issues/39) (this change), [#37](https://github.com/webnxt-2030/Centient/issues/37) (instant payout), [#40](https://github.com/webnxt-2030/Centient/issues/40) (reconciler), [#41](https://github.com/webnxt-2030/Centient/issues/41) (QA gate). Follows [ADR-0005](0005-submit-enqueues-worker-pays.md) and [ADR-0006](0006-journal-payout-envelopes.md).

## Context

Before #37, an accepted answer credited the contributor's off-chain
`pendingBalanceUnits` (`creditReward`, a `CREDIT_REWARD` ledger row), and the
contributor withdrew it later as one on-chain lump sum, once it passed
`MIN_WITHDRAWAL_UNITS` (1 USDC). Since #37 the worker pays each answer on-chain
and raises only `totalEarnedUnits`. `creditReward` had no callers left.

The model was still visible and still held value. On 2026-09-21, read-only
against production:

| | Holders | USDC |
| --- | --- | --- |
| All non-zero balances | 10 | 7.86 |
| └ `demo@centient.work` (seeded) | 1 | 5.00 |
| **Real contributors** | **9** | **2.86** |
| No `G…` wallet (unpayable until one is bound) | 4 | 0.08 |
| Below the 1 USDC minimum | 8 | 1.60 |
| `accrued` answers, all time | 160 rows | 33.28 |

The account sheet still showed "Pending balance", "Min withdrawal" and a
Withdraw button. "Total earned" was fed the withdrawable balance, not earnings.
The seed re-credited the demo account with 5 USDC "ready to withdraw" on every
deploy.

## Decision

**D1: sunset withdrawal. Don't auto-pay, and don't freeze.**
- Nothing accrues. The only write that may still raise `pendingBalanceUnits` is
  `refundReversal`, which returns a failed legacy withdrawal to the balance it
  came from.
- `creditReward` is deleted. `lib/__tests__/payout-no-accrual.test.ts` fails if
  any shipped module writes a `CREDIT_REWARD` row or raises the balance anywhere
  else.
- `/api/me/withdraw` stays, legacy-only. A zero balance is refused with 409
  `no_balance`.
- **The minimum is waived.** Every remaining balance predates instant payout,
  and the minimum would strand 8 of the 10. `getMinWithdrawalUnits` and
  `MIN_WITHDRAWAL_UNITS` are removed, and a leftover value in an environment is
  ignored.
- The ban, shared-wallet, eligibility and USDC-trustline checks are unchanged.
- The account sheet shows the withdraw card ("Earlier balance") only while the
  balance is non-zero, and past withdrawals while any exist.

**D2: "Total earned" reads `totalEarnedUnits`, backfilled.**
- The earnings badge, the landing and the account sheet read `/api/me`
  `totalEarned`.
- The worker raises `totalEarnedUnits` only after it has paid, which is after
  submit returns. After an accepted answer, the page polls that submission's
  status in the background (`lib/payout-settle-watch.ts`) and refreshes
  `/api/me` once it is `sent` or `confirmed`. Opening the account sheet also
  refreshes it. The success screen still shows no payout progress.
- Accrued answers never raised that column, nor `submissionCount`. Migration
  `20260921210000_legacy_earnings_backfill` adds each user's sum of `accrued`
  `payoutAmountUnits` to `totalEarnedUnits`, and their count of `accrued`
  answers to `submissionCount`.
- Each user's addition is recorded once in `legacy_earnings_backfill`, keyed by
  user, so a second run adds nothing. The owed balance is not touched.

**D3: withdrawal code is kept as legacy-only, and nothing else is deleted.**
- Kept for as long as a balance or an in-flight withdrawal can exist:
  - `enqueueWithdrawal`;
  - `processWithdrawalJob`;
  - the reconciler's withdrawal path;
  - withdrawal eligibility;
  - flagged withdrawals and their admin queue;
  - `checkSharedWallet`;
  - `refundReversal`.
- `/api/me/balance` has no reader left and is removed. The ledger stays readable
  to admins.
- Historical rows stay for audit: `accrued` submissions, `UserBalanceLedger`,
  `WITHDRAWAL` jobs, flagged withdrawals.

**D4: the seed creates no balance.**
- `demo@centient.work` is created with nothing owed.
- A re-seed no longer writes `pendingBalanceUnits` or `totalEarnedUnits`, so
  whatever the account holds is a legacy balance like anyone else's.
- `SEED_ON_DEPLOY` is unchanged. Whether it stays on is ADR-0002's question.

**D5: wallet-less holders withdraw once they bind a wallet.**
- The four accounts with no `G…` wallet (0.08 USDC between them) stay owed.
- They can withdraw after claiming a wallet, like everyone else.

## Alternatives considered

**Auto-pay every wallet-holding balance** as a one-off instant payout. It would
close the liability at once, but it needs its own script, a double-pay guard and
a production run, all to move 2.78 USDC of real contributors' money. The four
wallet-less holders would still be owed. Rejected: a sunset reaches the same end
without a new payment path.

**Freeze the balances** in the ledger with no contributor action. That keeps
value nobody can reach, which is deletion in effect. Rejected.

**Show `totalEarned + pendingBalance`** instead of backfilling. It needs no
migration, but it still under-reports anything already withdrawn, and it keeps
the retired balance in the earnings path. Rejected.

## Consequences

- **The liability only shrinks.** It's at most 7.86 USDC, most of it the demo
  account. Once every balance is zero and no `WITHDRAWAL` job is in flight, the
  route, the withdraw card and the withdrawal worker path can be deleted. That
  will be a later change.
- **Withdrawals are still not journalled** ([ADR-0006](0006-journal-payout-envelopes.md)).
  - A `WITHDRAWAL` job keeps the process-death double-pay window for as long as
    withdrawal exists.
  - The exposure is bounded by the balances above. It needs a legacy holder to
    withdraw at the moment a deploy kills the worker.
  - Journalling withdrawals would cost more than the whole liability, so it's
    left as is.
- **`submissionCount` rises with the backfill.** It feeds the
  `WITHDRAWAL_MIN_SUBMISSIONS` eligibility gate, which production doesn't set.
  Where it is set, accrual-era contributors now clear it on the answers they
  actually gave.
- **The migration writes production data.** It runs once, in `web`'s pre-deploy,
  at the Epic 3 promotion. `legacy_earnings_backfill` records exactly what it
  added to each user.
