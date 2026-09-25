# ADR-0008: Reconcile multisig payouts on proof only

- **Status:** Accepted — 2026-09-21
- **Scope:** Deliverable 3 (instant wallet-native payout): how a broadcast payout reaches a final state, and how "zero unreconciled" is shown.
- **Relates to:** [#40](https://github.com/webnxt-2030/Centient/issues/40) (this change), [#37](https://github.com/webnxt-2030/Centient/issues/37) (instant payout), [#38](https://github.com/webnxt-2030/Centient/issues/38) (attempts journal), [#41](https://github.com/webnxt-2030/Centient/issues/41) (QA gate). Follows [ADR-0006](0006-journal-payout-envelopes.md) and [ADR-0007](0007-retire-accumulate-then-withdraw.md). Operator detail: [payout-reconciliation.md](../payout-reconciliation.md).

## Context

At `feac16a` two reconcilers read the same `sent` rows and disagreed. The
in-process loop marked a payout `failed` after three bad answers; the
`/api/cron/payout-reconcile` route did so on the first. Neither checked what was
paid: `getTxStatus` read only Horizon's `successful`.

The loop also counted a thrown Horizon read as a failed payment. Three read
errors marked a payout `failed` with its hash kept, and refunded a legacy
withdrawal that may have paid. On 2026-09-21, read-only against production, row
`a5e7223b` had gone `failed` exactly this way: its hash is a QA fixture's
`qa-…`, which Horizon answers with a 400.

A `failed` row that keeps its hash is stuck. The retry path claims only rows
with no hash, so it is never paid, refunded or confirmed. `needs_reconciliation`
rows had no automatic path at all.

The cron route had no schedule. Its Railway service had already been disabled.

## Decision

**D1: one reconciler.** `lib/payout-reconcile.ts` is the only code that moves a
broadcast submission payout on Horizon's word, and the in-process loop is its
only caller. The cron route is deleted. Its Railway service still exists,
disabled, pending an account with the rights to delete it.

**D2: a read that throws is no answer.** Network errors, 5xx and 400s never
change a payout's status or retry budget, for a submission or a withdrawal, and
never refund. The error is recorded on the row, and Sentry pages once the payout
has been unreadable for 15 minutes. Only Horizon's answer moves a row with a
hash.

**D3: included and failed goes back to the retry path.** In one transaction, and
only while the row is still `sent` under that hash: clear the hash, void the
attempt, undo the totals credit, fail the job. The existing retry path builds the
one replacement. Each hand-back spends a retry, so an envelope that always fails
on-chain is not rebuilt forever. On the last one the campaign debit is refunded.

For that undo to be safe, `sent` must mean credited. Both payers now raise
`totalEarnedUnits` and `submissionCount` in the same write that records `sent`,
so a credit that cannot land quarantines the payment instead of leaving it
`sent` and uncredited.

**D4: confirm only what paid what was owed.** The envelope Horizon returns is
decoded and held to the submission: a fee bump paid by the payout account, an
inner transaction from that account, exactly one payment, to the bound wallet,
in the configured USDC, for the exact amount. A mismatch is held as
`needs_reconciliation` and paged; it is never confirmed. Without the payout
account or USDC issuer configured, nothing is confirmed.

**D5: settle held payouts on proof only.** A `needs_reconciliation` row with a
hash is a payment Horizon accepted. It is confirmed when Horizon shows it applied
and D4 matches, and handed back when Horizon shows it included and failed (unless
already refunded). **A held envelope Horizon no longer shows stays held.** This
departs from the recommendation it started from ("absent past expiry → retry"):
Horizon accepted it, so its absence means lost history, such as a testnet reset,
not non-payment. Rebuilding it would pay twice. A mismatch stays held and is
never looked up again.

**D6: a reproducible zero-unreconciled report.** `scripts/reconcile-report.ts`
reads the database (read-only, checked) and Horizon, and writes JSON and Markdown
for a submission-time window. Twelve named kinds count against zero. Hashes
Horizon can never answer for are excluded with a stated reason and listed:
`qa-…` fixture hashes, and the 34 pre-Stellar `0x…` EVM hashes in production.

**D7: withdrawals get D2 only.** No refund on a read error. Otherwise they stay
legacy-only and unjournalled, as ADR-0007 decided.

## Consequences

- **Deploy.** `web` needs `STELLAR_PLATFORM_ACCOUNT` and `STELLAR_USDC_ISSUER` for
  the reconciler to confirm anything. It already builds payouts with both.
- **No automatic path for a held payout Horizon cannot find.** It needs a human
  every time. After a testnet reset, every held row does.
- **The retry budget is the retry path's.** The loop's own three-strike count for
  submissions is gone. `SUBMISSION_RETRY_BUDGET` (5) bounds D3 hand-backs.
- **The report cannot run against production until it is migrated.** Production
  is on `20260914200000_sponsorship_reclaim`, before `payout_attempts` existed.
- **Held rows now take a Horizon read every 5 minutes each.** The QA fixture
  `qa-needs-reconciliation` draws a 400 and stays held, as intended.
