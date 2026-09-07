# Stellar USDC payout — failure runbook (ST-6a #306)

Support/ops reference for the Stellar **USDC** payout rail. Maps every failure mode
to what the system does automatically and what a human should do. The rail sends
USDC (Circle's Stellar asset) from one pooled platform account; recipients are
`G…` StrKey addresses that must hold a **USDC trustline** to receive.

Since E1-3 (#7) the reward path settles through the **two-signature multisig
payout service**, not the single-key `payUsdc` broadcast. The failure modes below
are unchanged, but the signing and sequence behavior now lives in
`stellar/payout-submitter.ts` — see
[the payout service runbook](./stellar-multisig-payout-service.md), which also
covers the co-signer failure modes this table does not.

## Failure modes at a glance

| Horizon code | Meaning | Retryable? | Automatic behavior | Support action |
|---|---|---|---|---|
| `op_no_trust` | Recipient `G…` exists but holds **no USDC trustline** | **No** | Payout marked **failed**, balance **refunded**, job retry budget consumed (no requeue). Surfaced to Sentry. | Tell the labeler to run **"Set up USDC payouts (free)"** (the sponsored-trustline flow, ST-4e) in their wallet, then re-withdraw. Their balance is intact. |
| `op_no_destination` | Recipient `G…` **doesn't exist / is unfunded** (never created on-chain) | **No** | Same as `op_no_trust`: failed + refunded + budget consumed. | The address was never created on-chain. The sponsored flow (ST-4e) creates + funds the account's base reserve. Have them complete "Set up USDC payouts", then re-withdraw. Double-check they linked the correct `G…`. |
| `tx_bad_seq` | Stale sequence number on the **payout** account (concurrency) | **Yes** | `submitMultisigPayout` rebuilds and resubmits **once** in-call, re-collecting both signatures because the rebuilt envelope has a new hash. If it still fails, it's classified retryable → the **job requeues** (backoff via the job queue, up to 3 attempts). | None normally — self-heals. If a job is stuck requeuing, check for a rogue second process submitting from the same platform key (sequence contention). |
| `op_low_reserve` | **Platform** account lacks XLM to fund a sponsored reserve (trustline flow) | **No** | Sponsored-trustline submit fails with a clear error (→ 400 at the route). | Top up the platform account's **XLM** (fees + base/trustline reserves). See wallet-health below. |
| `invalid_sponsor_tx` | A sponsored-trustline XDR was malformed / tampered / wrong shape | **No** | Rejected at the route (400) before submit. | Client-side/abuse signal — the co-signed envelope didn't match the platform-built shape. No money moved. |
| Timeout / Horizon 5xx / network | Submit or status read didn't complete | **Only once proven dead** | A missing hash is *not* evidence the payout never broadcast, so it alone never licenses a retry. `submitMultisigPayout` resolves the envelope by hash first (see below): it requeues only when Horizon reports the transaction absent as of a ledger that closed past its time bounds. Anything less resolves as `ambiguous_submit`, non-retryable, **without a refund**. If a broadcast tx isn't yet visible, the reconciler sees `not_found` (404) and **leaves it `sent`/`processing`** without burning a retry, re-checking next pass (~5s finality). | None for the retryable case — it self-heals. `ambiguous_submit` needs the reconciliation steps below. Check Horizon status if many jobs stall. |

## Trustline vs. destination — the two "recipient can't receive" cases

Both are **non-retryable** and both are fixed by the same in-app sponsored flow
(ST-4e), but they mean different things:

- **`op_no_destination`** — the `G…` account has never been created on-chain (it
  holds no XLM base reserve). It must be *created* first. The sponsored flow's
  `createAccount(recipient, "0")` branch handles this.
- **`op_no_trust`** — the account exists but has no **USDC trustline**. It must
  *add the trustline* (0.5 XLM reserve, platform-sponsored via CAP-33).

In both cases the labeler's **off-chain balance is refunded**, so no earnings are
lost — they just need to complete "Set up USDC payouts (free)" once, then withdraw
again. ST-4b prechecks the trustline at link time, so most users never hit these at
payout; this is the defense-in-depth catch if an address loses its trustline
between linking and payout.

## Double-submit protection, and the one window it does not cover

- A payout's tx hash is persisted (`payoutTxHash` / `PayoutJob.txHash`) **only after**
  `submitMultisigPayout` returns a hash. A submit that returns a definite rejection
  (the transaction was never applied) leaves the job with no hash → the worker
  requeues and re-submits with a fresh sequence, which is safe.
- **An *ambiguous* submit is resolved by identity, never by rebuilding.** If Horizon
  accepted the transaction but the response was lost — a client timeout, a dropped
  connection, a 5xx after acceptance — `submitMultisigPayout` does **not** rebuild.
  The envelope hash is computed *before* submission, so the service polls Horizon
  for that exact transaction until it is found, or until it is provably dead. A
  payout that actually settled returns its real hash. This closes the
  double-settlement window that `payUsdc` had.
- **What counts as provably dead.** Exactly one thing licenses a rebuild: Horizon
  reporting the transaction **absent**, as of an ingested ledger whose `close_time`
  is **strictly past** the envelope's `maxTime`. Stellar judges time bounds against
  ledger close time, so the worker's own clock is never the authority — a host
  running ahead would otherwise retire an envelope the network would still include.
  A status lookup that *fails* proves nothing either; the service keeps polling the
  same hash rather than treating an unreachable Horizon as absence.
- **Everything short of that proof is non-retryable**, and deliberately so: an
  envelope with no time bounds, or one whose fate Horizon would not confirm before
  the resolve deadline, is reported as `ambiguous_submit` with `retryable: false`
  for a human, rather than rebuilt into a possible second settlement.
- **`ambiguous_submit` is never refunded.** Every other non-retryable code is a
  verdict that the payment never applied, so the balance goes back. This one is the
  *absence* of a verdict — refunding a payout that did settle pays the labeler twice,
  once on-chain and once off. The job is marked `failed` with a
  `needs manual reconciliation` error and paged to Sentry at `error`; the balance is
  left alone until a human resolves it.
- **Residual:** if the process dies between submitting and resolving, the in-memory
  hash is lost and the job requeues without it — the one path that can still retry
  an unresolved submit. Surviving that requires persisting the hash before submit;
  see the payout service runbook.
- **Operationally:** a payout that fails with `ambiguous_submit`, or one that
  requeued after a process death mid-submit, needs a human **before** any re-run.
  Check the payout account's recent transactions for the destination and amount. If
  it settled, record the hash and mark the job done rather than reissuing; only
  re-run once you have confirmed nothing landed.
- Once a hash exists, the **reconciler** owns the outcome: it polls Horizon and moves
  `sent → confirmed` (or `failed`). A `not_found` (404) is treated as *still pending*
  (Horizon read-lag before ledger inclusion), so the payout stays `sent` and is not
  re-submitted.
- The worker heartbeats the in-flight job well within the stale-claim window so a
  second worker can't reclaim and double-pay a slow-but-live payout.

## Wallet-health alerts (dual-asset)

The pooled platform account is monitored on **two** balances (ST-3c), each with its
own warn/page threshold and a 15-min alert cooldown:

- **USDC float** — funds withdrawals. Low float → payouts can't be funded.
  Env: `BALANCE_WARN_USDC` (default 50), `BALANCE_PAGE_USDC` (default 10).
- **XLM fee/reserve floor** — pays every tx fee + base/trustline reserves. Low XLM →
  **no** payout can be submitted even with USDC on hand. Sponsored recipient
  reserves (`0.5 × num_sponsoring`) are subtracted from the reported XLM so the
  floor reflects *available* fee XLM, not locked reserves.
  Env: `BALANCE_WARN_XLM` (default 5), `BALANCE_PAGE_XLM` (default 2).

Alerts go to `DISCORD_WEBHOOK_URL` and name which asset crossed which threshold.
`/api/health/wallet` reports both balances live.

## Daily payout cap

Enforced in **USDC units** (7-dec base units; ST-2b). When the cap is hit, the
payout is marked failed/skipped and the balance (campaign or user) is refunded,
retry budget consumed. Env: `MIN_WITHDRAWAL_UNITS` and the cap envs are all in USDC
units, not XLM stroops.
