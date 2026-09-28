# Payout reconciliation

How a broadcast instant payout reaches a final, proven state, and how to show
that none are left unaccounted for. Decided in
[ADR-0008](adr/0008-reconcile-multisig-payouts.md) (#40).

## The reconciler

`lib/reconciler.ts` runs in-process from `instrumentation.ts` (or standalone as
`npm run reconciler`). Every submission it settles goes through
`lib/payout-reconcile.ts`; nothing else moves a broadcast submission payout on
Horizon's word. There is no reconcile cron.

It reads each hash with `lookupTx`, which returns Horizon's outcome and, once the
transaction is included, the envelope it applied.

### A `sent` payout

| Horizon says | What happens |
| --- | --- |
| Applied, and the envelope pays what the submission owed | `confirmed` |
| Applied, but the envelope differs | `needs_reconciliation`, `payoutError` starting `payout mismatch:`, Sentry `error`. Nothing is undone or rebuilt. |
| Included and failed | Handed back to the retry path: hash cleared, attempt voided, totals credit undone, one retry spent. On the last retry the campaign debit is refunded. |
| Not found (404) | Stays `sent`. Horizon read-lag. |
| The read throws (network, 5xx, a 400 on a malformed hash) | Stays `sent`, error recorded in `payoutError`. Sentry `warning` once it is 15 minutes old. |

"What the submission owed" is checked on the envelope itself
(`lib/stellar/payout-verify.ts`): a fee bump paid by `STELLAR_PLATFORM_ACCOUNT`,
an inner transaction from that account, exactly one payment operation, to the
submission's bound wallet, in USDC from `STELLAR_USDC_ISSUER`, for exactly
`payoutAmountUnits`. Without both variables configured, nothing is confirmed:
rows stay `sent` and Sentry pages at `error`.

### A held payout (`needs_reconciliation` with a hash)

These are payments Horizon **accepted** that could not be recorded. The
reconciler looks each one up every 5 minutes:

| Horizon says | What happens |
| --- | --- |
| Applied, and matches | `confirmed`, with its attempt confirmed and the user's totals credited in the same write |
| Applied, but differs | Stays held, marked `payout mismatch:`. Never looked up again. |
| Included and failed | Handed back to the retry path, unless its campaign debit was already refunded |
| Not found, or unreadable | Stays held |

A held envelope that Horizon no longer shows is **not** evidence it never paid.
Horizon accepted it; its absence means lost history, such as a testnet reset.
Rebuilding it would pay twice, so it stays for a human.

### Legacy withdrawals

A Horizon read error never refunds or fails a `WITHDRAWAL` job. Everything else
about withdrawals is unchanged ([ADR-0007](adr/0007-retire-accumulate-then-withdraw.md)).

## Retries, the attempt journal and revival (#38)

The reconciler settles *broadcast* payouts. Before a broadcast, and after an
unknown one, three more pieces keep a payout converging on one outcome. They are
decided in [ADR-0006](adr/0006-journal-payout-envelopes.md).

### The attempt journal

`payout_attempts` holds one row per signed envelope: its hash, its `maxTime` and
a status of `open`, `confirmed` or `void`. A partial unique index allows **one
`open` attempt per submission**. `submitMultisigPayout` opens the attempt after
both signatures and before it submits. If that write fails, nothing is
submitted. The co-signer refuses to sign while the submission has an `open`
attempt.

An attempt is voided only on proof the envelope cannot apply: a definite
rejection, an inclusion that failed, or an absence proven past its time bounds.
Anything unprovable stays `open`. A landed attempt is confirmed in the same write
that records the submission's hash.

### Settle before building

Every payer (the worker, the retry cron, admin retry) takes the submission's
row claim and then calls `settleOpenAttempt` before building anything:

| Horizon says about the open attempt | Result |
| --- | --- |
| Landed | Recorded as the payment. Nothing is sent |
| Included and failed | Voided. One new envelope is built |
| Absent, in a lookup after a ledger closed past `maxTime` | Voided. One new envelope is built |
| Still inside its bounds, or unreachable | Wait. The worker requeues with `PayoutJob.notBefore`. The retry path throws `attempt_unsettled`. Neither spends a retry |

### The retry cron (`POST /api/cron/payout-retry`)

It picks up to 100 submissions per call that no live `SUBMISSION_PAYOUT` job
owns:

- `pending` rows older than 5 minutes;
- `failed` rows past their backoff, which is `min(2^retryCount × 60 s, 8 min)`.

Each goes through `reprocessPayoutWithNonceSafety`, grouped by wallet. A
non-retryable rail error (`op_no_trust`, `op_no_destination`) exhausts the
budget at once. The call ends with the abandon sweep: every `pending` or
`failed` row with `retryCount >= 5` (`SUBMISSION_RETRY_BUDGET`) becomes
`abandoned`. The co-signer's "not now" answers (#47) hold a row without spending
its budget. See the [failure matrix](payout-failure-matrix.md).

### Revival of stranded attempts

An unprovable `ambiguous_submit` leaves a submission `failed` with its budget
spent, unrefunded, and its envelope still `open`. The abandon sweep may relabel
it `abandoned`. No payer returns to such a row on its own.

`reviveStrandedAttempts` (`lib/payout-attempt-revival.ts`) runs on every idle
reconciler pass, 20 rows at a time, oldest expiry first. It picks rows that
meet all of the following:

- an `open` attempt past `expiresAt`;
- `failed` or `abandoned`;
- no hash, and its retry budget spent;
- a wallet;
- **no refund**.

For each one, it takes the row claim and settles the attempt:

| Settlement | Result |
| --- | --- |
| Landed, or proven void | `revived`: back to `failed` with `retryCount` 0 and a `payoutError` saying which. The retry cron's next pass records the landed envelope, or builds the one replacement |
| Still unprovable | `waiting`: left as it is, and asked again on a later pass |
| Refunded meanwhile, or claimed by another payer | `skipped` |

Revival never writes a payment itself. The retry path stays the only writer. A
refunded row is never revived, because paying it now would pay with no funding
behind it.

## The zero-unreconciled report

```bash
npm run reconcile:report -- --since=2026-09-24T00:00:00Z --until=2026-09-25T00:00:00Z
npm run reconcile:report -- --hours=24 --out=evidence/run-1
```

Writes `report.json` (machine-readable) and `report.md` (reviewer-readable).
Exit code 0 means zero unreconciled, 1 means findings, 2 means the report could
not be produced.

- **Read-only.** Every database session opens with
  `default_transaction_read_only=on`, and the script refuses to start unless the
  server confirms it. Horizon is only read.
- **Needs** `DATABASE_URL`, `STELLAR_NETWORK`, `STELLAR_PLATFORM_ACCOUNT` and
  `STELLAR_USDC_ISSUER`. `--no-horizon` skips Horizon, but then no confirmed payout
  can count as reconciled, so the report is never zero.
- **Window** is by submission time. `--sent-overdue-min` (default 30) sets how
  long a `sent` payout may wait before it counts against zero.

Every submission in the window is counted by status. Every one with a hash lands
in exactly one of:

- **Reconciled**: `confirmed`, and Horizon shows the envelope paid what was owed.
- **Pending**: `sent` inside the grace period.
- **Excluded**, with the reason: a `qa-…` hash minted by `lib/qa-fixtures`, or a
  `0x…` EVM hash from before the move to Stellar. Horizon can answer for neither.
  They are listed, never dropped.
- **Unreconciled**, under one or more kinds:

| Kind | Meaning |
| --- | --- |
| `sent_overdue` | `sent` past the grace period |
| `terminal_with_hash` | `failed` or `abandoned`, yet carrying a hash |
| `held` | `needs_reconciliation`, awaiting proof |
| `held_mismatch` | `needs_reconciliation` because what applied differs |
| `attempt_expired_open` | an `open` payout attempt past `expiresAt` |
| `shared_hash` | one hash on more than one submission |
| `multiple_landed_attempts` | more than one `confirmed` attempt for one submission |
| `horizon_mismatch` | `confirmed`, but the envelope differs |
| `horizon_failed` | `confirmed`, but Horizon shows it included and failed |
| `horizon_missing` | `confirmed`, but Horizon has no such transaction |
| `horizon_unreadable` | `confirmed`, but Horizon could not be read |
| `horizon_unchecked` | `confirmed`, and the report ran with `--no-horizon` |

**Zero** means the unreconciled list is empty. The same database and chain give
the same findings.

### The volume proof (#49)

```bash
npm run reconcile:report -- --since=<run start> --min-settlements=100 --min-wallets=25
```

The same report is read as the D4 evidence run. Every report has a **Volume**
section, and each count is of submissions: a submission with several findings
counts once.

| Count | Meaning |
| --- | --- |
| Successful | reconciled on Horizon |
| Unique wallets | distinct wallets among the successful payouts |
| Rejected | `skipped`: refused by a quality guard, so nothing was owed |
| Failed | `failed` or `abandoned` |
| Duplicate | carrying `shared_hash` or `multiple_landed_attempts` |
| Unreconciled | carrying any finding |

With `--min-settlements` and `--min-wallets`, which must be given together, the
report judges the window. The target is met only with enough successful payouts,
enough unique wallets, and zero duplicate and zero unreconciled payouts. The exit
code is then 1 when the target is not met. Wallets appear shortened (`GABC…WXYZ`)
with their payout counts. Each full address is on its linked transaction.
