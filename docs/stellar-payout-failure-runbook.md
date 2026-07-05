# Stellar USDC payout — failure runbook (ST-6a #306)

Support/ops reference for the Stellar **USDC** payout rail. Maps every failure mode
to what the system does automatically and what a human should do. The rail sends
USDC (Circle's Stellar asset) from one pooled platform account; recipients are
`G…` StrKey addresses that must hold a **USDC trustline** to receive.

## Failure modes at a glance

| Horizon code | Meaning | Retryable? | Automatic behavior | Support action |
|---|---|---|---|---|
| `op_no_trust` | Recipient `G…` exists but holds **no USDC trustline** | **No** | Payout marked **failed**, balance **refunded**, job retry budget consumed (no requeue). Surfaced to Sentry. | Tell the labeler to run **"Set up USDC payouts (free)"** (the sponsored-trustline flow, ST-4e) in their wallet, then re-withdraw. Their balance is intact. |
| `op_no_destination` | Recipient `G…` **doesn't exist / is unfunded** (never created on-chain) | **No** | Same as `op_no_trust`: failed + refunded + budget consumed. | The address was never created on-chain. The sponsored flow (ST-4e) creates + funds the account's base reserve. Have them complete "Set up USDC payouts", then re-withdraw. Double-check they linked the correct `G…`. |
| `tx_bad_seq` | Stale sequence number on the **platform** account (concurrency) | **Yes** | `payUsdc` reloads the account + resubmits **once** in-call. If it still fails, it's classified retryable → the **job requeues** (backoff via the job queue, up to 3 attempts). | None normally — self-heals. If a job is stuck requeuing, check for a rogue second process submitting from the same platform key (sequence contention). |
| `op_low_reserve` | **Platform** account lacks XLM to fund a sponsored reserve (trustline flow) | **No** | Sponsored-trustline submit fails with a clear error (→ 400 at the route). | Top up the platform account's **XLM** (fees + base/trustline reserves). See wallet-health below. |
| `invalid_sponsor_tx` | A sponsored-trustline XDR was malformed / tampered / wrong shape | **No** | Rejected at the route (400) before submit. | Client-side/abuse signal — the co-signed envelope didn't match the platform-built shape. No money moved. |
| Timeout / Horizon 5xx / network | Submit or status read didn't complete | **Yes (soft)** | If the **submit** never returned a hash, the job requeues — no hash means no confirmed broadcast, so no double-pay on retry. If a broadcast tx isn't yet visible, the reconciler sees `not_found` (404) and **leaves it `sent`/`processing`** without burning a retry, re-checking next pass (~5s finality). | None normally. Persistent Horizon unavailability pages via wallet-health only indirectly; check Horizon status if many jobs stall. |

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

## No double-submit guarantee

- A payout's tx hash is persisted (`payoutTxHash` / `PayoutJob.txHash`) **only after**
  `payUsdc` returns a hash. A submit that never returns a hash (timeout/error) leaves
  the job with no hash → the worker requeues and re-submits with a fresh sequence.
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
