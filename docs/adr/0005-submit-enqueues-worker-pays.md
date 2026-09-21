# ADR-0005: Submit enqueues the payout; the worker pays it

- **Status:** Accepted — 2026-09-21
- **Scope:** Deliverable 3 (instant wallet-native payout): the submit path and the multisig payout rail it now feeds.
- **Relates to:** [#37](https://github.com/webnxt-2030/Centient/issues/37) (instant payout), [#38](https://github.com/webnxt-2030/Centient/issues/38) (idempotency and retries), [#39](https://github.com/webnxt-2030/Centient/issues/39) (retire accumulate-then-withdraw), [#41](https://github.com/webnxt-2030/Centient/issues/41) (Epic 3 QA gate). Builds on [ADR-0004](0004-wallet-native-quality-guards.md).

## Context

Until #37 an accepted answer was written `accrued` and credited to the
contributor's off-chain balance, which was paid only on withdrawal. The
multisig rail could already pay one submission at a time (`SUBMISSION_PAYOUT`
jobs, `processSubmissionPayout`, the co-signer's `kind: "submission"` check),
but nothing enqueued those jobs.

Five things stood between that dormant rail and paying an answer safely:

1. The worker, on success, also credited `pendingBalanceUnits` and wrote a
   `CREDIT_REWARD` row, so a paid reward could be withdrawn a second time.
2. `REWARDED_STATUSES` left out `pending`, so a task could be over-answered, and
   over-paid, while its payouts were in flight.
3. The worker and the retry cron each held their own lease on a `pending` row
   with no hash (the job's heartbeat and the row's `lastRetriedAt`). Neither read
   the other's. The co-signer signs any `pending` row with no hash, so both
   could broadcast.
4. When the worker refunded a failed payout's campaign debit, it left
   `Submission.retryCount` under the cron's budget, so the cron could pay a row
   whose funding had been returned. Conversely, when the retry path gave up on
   a campaign-backed row, nothing returned the campaign debit.
5. The per-submission status read required an EVM `0x…` wallet parameter and
   rejected every Stellar contributor.

## Decision

**Submit enqueues and the worker pays.** In one transaction, submit writes the
campaign debit (when the task has one), the `pending` row carrying the reward,
and one `SUBMISSION_PAYOUT` job. All three exist or none do. The request never
broadcasts. The worker claims the job, and the co-signer re-derives destination
and amount from the row before it signs. Submit answers `status: "pending"`,
which is true: the payout is queued, not sent.

**Only an accepted answer reaches signing.** Every rejection writes `skipped`
with no amount and no job (`payout-intent-db.test.ts`). The co-signer signs only
`pending` or `failed` rows with no hash, so `skipped`, `accrued` and
`abandoned` rows are refused independently of the payout service.

**One payer at a time.** Before it broadcasts, the worker takes the same row
claim (`claimForRetry`, under the per-wallet advisory lock) that the retry cron
and the admin retry take. It stands down if another payer holds the claim, and
hands the claim back when an attempt ends without a broadcast. The cron skips
rows whose job is still `queued` or `processing`. A payer that refunds writes
`SUBMISSION_RETRY_BUDGET`, so the cron never offers that row again. Whichever
payer gives up on a campaign-backed row returns its debit
(`lib/payout-refund.ts`), except after an `ambiguous_submit`, which may have
settled. A refund is keyed to its submission and applied at most once, and an
admin retry refuses a submission whose debit was refunded rather than pay it
from platform funds.

**Paid rewards are earned, not withdrawable.** The worker credits
`totalEarnedUnits` and `submissionCount` only. Existing `pendingBalanceUnits`
stay withdrawable until #39 retires the route. No balance is migrated.

**`pending` fills the response target, but only settled answers decide it.**
`pending` is part of `REWARDED_STATUSES`, which reserves room under the target:
task serving, submit's target check and admin counts. Agreement scoring and task
resolution use `SETTLED_STATUSES` (`sent`, `confirmed`, `accrued`), because an
in-flight payout can still fail and be refunded, and a resolved task is never
recomputed. On-chain spend keeps its own set in `payout-cap`.

**Funding.**

| Answer | Debit | Paid on-chain |
| --- | --- | --- |
| Campaign task | reward + platform fee from the campaign | yes |
| Campaign-less task (the live tester questions) | none: platform-funded | yes |
| Passed gold check | none | **no**: recorded `skipped`, 0 |

A passed gold earns nothing because no campaign funds it. It is served like any
other task, so the contributor learns it was a quality check only from the
result (`reason: "quality_check_passed"`), after answering.

**Status is a session read.** `GET /api/submissions/[id]` matches the row on the
session's `userId`, takes no wallet parameter, and answers 404 for another
contributor's submission.

## Consequences

- **Platform-funded exposure.** Campaign-less answers draw on the payout
  account with no debit. The daily cap (checked by both the payout service and
  the co-signer) is what bounds it.
- **The retry claim's residual is unchanged.** The claim is a lease with a
  best-effort heartbeat. A process that dies mid-broadcast lets the lease
  expire without a stored hash. Closing that needs the envelope hash persisted
  before submit, which is #38's state-machine change.
- **Earnings display.** The earnings badge and account sheet still show the
  withdrawable balance, which instant payouts no longer grow. Switching them to
  `totalEarnedUnits` would under-report earnings accrued before #37, which never
  touched that column. The display follows #39.
- **The success screen** says the reward is on its way. Payout progress is
  read from the account sheet, and the ranking screen does not poll.
