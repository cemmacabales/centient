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
