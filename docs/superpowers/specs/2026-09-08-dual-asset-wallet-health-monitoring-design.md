# Dual-Asset Wallet-Health Monitoring Design

**Issue:** #11
**Date:** 2026-09-08
**Base branch:** `develop`

## Objective

Give operators one reliable view of the USDC reward float, spendable XLM fee
capacity, payout anomalies, daily-cap pressure, permanent failures, and cold
reserve refill health. Alerts must remain distinct and deduplicated across
processes without presenting missing monitoring data as a healthy rail.

## Source of Truth for Payout Activity

`PayoutJob` becomes the source of truth for actual on-chain payout activity.
Current contributor rewards accrue off-chain on `Submission`; the primary
on-chain flow is a later `PayoutJob(type: WITHDRAWAL)`. Counting successful
`Submission` rows therefore misses real withdrawals.

Add nullable `PayoutJob.broadcastAt`. When Stellar accepts a payout, persist
`txHash`, `amountUnits`, and `broadcastAt` together before later reconciliation.
Both withdrawal jobs and the retained legacy submission-payout path follow this
contract. A network success followed by a database write failure remains an
existing distributed-transaction ambiguity and must be logged and surfaced as a
monitoring error rather than guessed from a failed job state. Add indexes for
`broadcastAt` and the recurring failure query on `(status, completedAt)`.

The migration backfills historical rows:

- Jobs that already have `txHash` receive `broadcastAt` from `completedAt`, then
  `updatedAt`, then `createdAt` as the best available historical approximation.
- Submission payout jobs copy a missing amount/hash from their linked
  `Submission` before the timestamp backfill.

Rolling count, volume, and cap calculations include only jobs with a non-null
transaction hash, amount, and `broadcastAt` inside the requested window. This
prevents queued and permanently failed attempts from inflating spend.

Issue #11 corrects the cap's accounting source but does not introduce a new
cross-process cap-reservation protocol. It preserves the current process-local
submission serialization; distributed atomic cap reservations are a separate
enforcement change and should be tracked independently.

## Spendable XLM

Wallet health must distinguish total native XLM from the amount available for
fees. For the platform account, calculate:

```text
minimum balance = live base reserve ×
  (2 + subentry_count + num_sponsoring - num_sponsored)

spendable XLM = max(
  0,
  total native balance - native selling liabilities - minimum balance
)
```

Read the live base reserve from Horizon's latest ledger. Expose total balance,
minimum balance, selling liabilities, and spendable balance in `WalletHealth`.
USDC matching continues to require both asset code and configured issuer.

## Monitoring States

Configuration absence and runtime failure are different states:

- `healthy`: the source was read successfully and thresholds were evaluated.
- `unconfigured`: required environment values are absent or invalid.
- `error`: configuration exists, but Horizon, the database, or reserve lookup
  failed.

Unknown data never becomes a zero balance and never appears healthy. Wallet and
reserve monitoring failures create their own deduplicated alert identities and
appear in the admin status banner. Error payloads and logs expose error classes,
not secrets or full configuration messages.

## Alert Delivery and Deduplication

Each condition has a stable Redis key: USDC warn/page, XLM warn/page, payout rate,
payout volume, cap pressure, repeated failures, overdue refill, and monitoring
unavailable.

For each alert delivery:

1. Acquire a short Redis lease with a random ownership token using `SET NX PX`.
2. Deliver to Discord with a bounded timeout shorter than the lease.
3. On success, atomically replace the owned lease with the configured cooldown.
4. On failure, delete the lease only if the stored token still belongs to this
   sender.

Lua compare-and-set/delete operations prevent an expired sender from deleting a
newer's cooldown. If Redis is unavailable, warning alerts fail closed to prevent
spam. Page-severity alerts fail open through a bounded in-process cooldown so a
Redis incident cannot suppress every critical page. Delivery results identify
this degraded path for the cron response and logs.

## Snapshot and Entry Points

`getHealthMonitorSnapshot` gathers, in parallel:

- Stellar wallet health and reserve math;
- rolling payout-job count and volume;
- rolling 24-hour cap spend;
- recent permanent payout-job failures;
- cold reserve refill plan and its Redis-backed due-since marker.

Each source reports its own `healthy`, `unconfigured`, or `error` state. A source
failure yields unavailable metrics (`null` in JSON and an em dash in the admin
view), not numeric zero, while the remaining sources continue to render. A
top-level snapshot failure is caught by `runHealthMonitor`, which attempts the
deduplicated monitoring-unavailable page before returning an error to the cron
caller.

`runHealthMonitor` evaluates alerts and sends each through the shared delivery
boundary. `POST /api/cron/wallet-health` authenticates with `CRON_SECRET` and
returns JSON-safe metrics, active alerts, and delivery outcomes.

The admin status page consumes the same snapshot and shows:

- USDC reward float;
- total, reserved/minimum, and spendable XLM;
- payout count and volume for the configured anomaly window;
- daily cap utilization;
- permanent failure count;
- cold reserve balance, plan state, and refill due time;
- monitoring errors and active alerts.

`GET /api/health/wallet` retains all existing fields and adds spendable XLM,
minimum-balance inputs, asset status, and monitoring status so external checks see
the same values that drive alerts.

## Configuration

Existing balance thresholds remain:

- `BALANCE_WARN_USDC`, `BALANCE_PAGE_USDC`
- `BALANCE_WARN_XLM`, `BALANCE_PAGE_XLM`

Anomaly and delivery settings are:

- `HEALTH_PAYOUT_WINDOW_MINUTES`
- `HEALTH_PAYOUT_COUNT_THRESHOLD`
- `HEALTH_PAYOUT_VOLUME_UNITS_THRESHOLD`
- `HEALTH_FAILURE_WINDOW_MINUTES`
- `HEALTH_FAILURE_COUNT_THRESHOLD`
- `HEALTH_CAP_PERCENT_THRESHOLD`
- `HEALTH_REFILL_OVERDUE_MINUTES`
- `HEALTH_ALERT_COOLDOWN_MS`
- `HEALTH_ALERT_DELIVERY_TIMEOUT_MS`

Invalid optional values fall back to documented defaults. Required Stellar,
reserve, and cron settings retain explicit `unconfigured` behavior. Missing
Discord configuration disables delivery visibly. Missing or unavailable Redis
suppresses warnings but uses the bounded local fallback for page-severity alerts.

## Testing and Verification

Tests cover:

- current `WITHDRAWAL` payout jobs contributing to count, volume, and cap spend;
- legacy submission payout backfill/recording behavior;
- full Stellar minimum-balance math, sponsorship offsets, native liabilities,
  and zero-floor behavior;
- distinct USDC and XLM alert identities;
- monitoring `unconfigured` and `error` states;
- Redis ownership races, Discord timeout, and page-severity Redis fallback;
- anomaly boundaries, refill timing, cron authentication, JSON safety, public
  health output, and the rendered admin view.

Before the PR is updated, run the full test suite, TypeScript typecheck, Prisma
migration validation through generation/build, and the production Next.js build.

## Rollout

Apply the Prisma migration before deploying application code. Configure the
documented thresholds and schedule `POST /api/cron/wallet-health` at least once
per minute. The final epic QA issue (#13) performs live balance and anomaly
simulation; issue #11 supplies automated demonstrations and operator guidance.
