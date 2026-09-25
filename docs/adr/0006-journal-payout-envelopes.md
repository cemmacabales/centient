# ADR-0006: Journal every payout envelope before it is submitted

- **Status:** Accepted — 2026-09-21
- **Scope:** Deliverable 3 (instant wallet-native payout): how a submission payout converges on one outcome across retries, restarts and unknown Horizon results.
- **Relates to:** [#38](https://github.com/webnxt-2030/Centient/issues/38) (idempotency and retries), [#39](https://github.com/webnxt-2030/Centient/issues/39) (retire withdrawals), [#40](https://github.com/webnxt-2030/Centient/issues/40) (reconciler), [#41](https://github.com/webnxt-2030/Centient/issues/41) (QA gate). Closes the residual recorded in [ADR-0005](0005-submit-enqueues-worker-pays.md).

## Context

After #37, a submission payout had one payer at a time: the worker and the
retry path share a row claim. But what the rail remembered about an envelope
lived only in memory. The envelope hash is known before submit, yet it was
written only after Horizon answered.

The payout worker runs inside the `web` process (`instrumentation.ts`), so a
redeploy kills whatever is in flight. Killed between an accepted submit and the
write, the submission read `pending` with no hash. The next payer took the
lapsed claim and built a new envelope on the next sequence number. The
co-signer, which also reads "pending, no hash", signed it too. **Paid twice.**

## Decision

**The idempotency key is the submission id; each signed envelope is an attempt.**
`payout_attempts` holds one row per envelope: its hash, its `maxTime`, and a
status of `open`, `confirmed` or `void`. A partial unique index allows **one
`open` attempt per submission**, so "one live envelope" is a database rule.

**Journal before submit.**
- `submitMultisigPayout` takes an attempt journal. Once the envelope is fully
  signed, it opens the attempt, and only then submits. If the journal write
  fails, nothing is submitted.
- It voids the attempt only on proof that the envelope cannot apply:
  - a definite rejection (including the `tx_bad_seq` envelope, before the
    rebuild opens its own);
  - an inclusion that failed;
  - an absence proven past its time bounds.
- An unprovable outcome stays `open`.
- `payReward` journals every submission payout, so no caller can skip it.
- Opening an attempt locks the submission row and refuses unless the row is
  still payable (`pending`/`failed`, no hash). The one-open index alone would
  let a payer that took its signatures early open a second envelope the moment
  the first is confirmed. The lock serializes it with the write that records
  the payment, so it sees that payment and stops.

**Settle before building.** After taking the row claim, and before building
anything, the worker and the retry path (and through it, admin retry) call
`settleOpenAttempt`. It asks Horizon about that exact hash:

| Horizon says | Result |
| --- | --- |
| Landed | Record it as the payment; send nothing |
| Included and failed | Void it; build one new envelope |
| Absent, in a lookup made after a ledger closed strictly past `maxTime` | Void it; build one new envelope |
| Anything else (still inside its bounds, or Horizon unreachable) | Wait. The worker requeues the job with `PayoutJob.notBefore`; the retry path throws `attempt_unsettled`. Neither spends a retry |

The proof order is the one `resolveAmbiguousSubmit` already relied on: observe
the post-expiry ledger, then look again.

**A landed attempt is confirmed only in the write that records its hash.**
Confirming it first would let a crash in between leave a row with no hash and
no open attempt, which reads as unpaid.

**The co-signer refuses while an attempt is open.** `readLedgerPayout` returns
the submission's open attempt, read in the same SQL statement as the row so the
two are one snapshot, and `assertLedgerAgrees` refuses to sign. Both
signatures for an envelope are taken before its attempt opens, so a legitimate
attempt is never refused. The migration grants the co-signer's read-only role
(`centient_cosigner`) `SELECT` on `payout_attempts`, where that role exists.

**Unknown outcomes stay reconcilable.** An unprovable `ambiguous_submit` leaves
a submission `failed` with its budget spent, unrefunded, and its envelope open.
The reconciler's idle pass settles such envelopes once they are past their
bounds.
- If the outcome is proven either way, it hands the row back to the retry path,
  which records the landed payment or builds the one replacement.
- It never revives a refunded row.

**Request retries converge.** A concurrent duplicate submit is refused by
`@@unique([userId, taskId])` inside its transaction, and now answers 409
`already_submitted` instead of 500.

## Consequences

- **What waiting costs.** An envelope whose fate is unknown holds its payout
  for up to `TX_TIMEOUT_SECONDS` (180 s) plus one ledger before a replacement
  can be built. That is the price of never guessing.
- **Deploy order.** `web` runs the migration and `cosigner` deploys separately.
  The co-signer's new read fails if the table or the grant is missing. It then
  refuses to sign, and payouts retry. That is safe, but deploy `web` (which
  migrates) before or with `cosigner`.
- **Withdrawals are not journalled.** `WITHDRAWAL` jobs keep the old window
  until #39 retires them. #39 sunsets withdrawal to legacy balances only and
  leaves them unjournalled; see [ADR-0007](0007-retire-accumulate-then-withdraw.md).
- **Out of scope, owned by #40:**
  - `needs_reconciliation` quarantines, which carry a hash and stay manual;
  - the in-process reconciler turning three Horizon read errors into `failed`.
- **Sequence mutex.** It is still process-local. With more than one `web`
  replica, sequence collisions cost throughput (`tx_bad_seq`, one rebuild),
  not correctness, and every rebuild is journalled.
