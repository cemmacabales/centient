# Dual-Asset Wallet-Health Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver reliable USDC/XLM wallet-health and payout-anomaly monitoring whose balances, cap accounting, failure states, and Discord deduplication reflect the actual Stellar payout rail.

**Architecture:** Record every accepted Stellar payment on `PayoutJob`, then derive rolling payout activity and cap spend from those durable broadcast records. Calculate spendable XLM from live protocol reserve data, collect each monitor source with an explicit state, and send alerts through an ownership-safe Redis lease with a bounded critical-alert fallback.

**Tech Stack:** Next.js 16.2 App Router, TypeScript, Prisma/PostgreSQL, Stellar SDK/Horizon, ioredis, Discord webhooks, Vitest, React server rendering

**Spec:** `docs/superpowers/specs/2026-09-08-dual-asset-wallet-health-monitoring-design.md`

## Global Constraints

- Work only on `codex/feat-issue-11-wallet-health`, created from `origin/develop` in `.worktrees/codex-feat-issue-11-wallet-health`.
- Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` before changing route handlers; this repository uses Next.js 16.2 conventions.
- Keep `PayoutJob` as the only source for actual on-chain payout count, volume, and cap spend.
- Preserve exact seven-decimal Stellar units in database calculations; convert to display strings only at response/UI boundaries.
- Never serialize unknown monitoring data as numeric zero or label it healthy.
- Do not add a distributed cap-reservation protocol; that enforcement change remains outside issue #11.
- Every commit must use `cemmacabales <carlmacabales31@gmail.com>` with no co-author trailers or automated attribution.
- Push the completed branch and open a PR against `develop` only after all verification and review gates pass.

---

## File Structure

- `prisma/schema.prisma` and `prisma/migrations/20260908090000_add_payout_broadcast_monitoring/migration.sql`: durable broadcast timestamp, data backfill, and query indexes.
- `lib/payout-worker.ts` and `lib/payout-service.ts`: persist broadcast hash, amount, and time in both payout flows.
- `lib/payout-cap.ts`: query payout-job activity and expose one reusable rolling metrics function.
- `lib/stellar/balance.ts`: exact live reserve/liability math and wallet monitoring state.
- `lib/health-alert.ts`: Discord timeout, Redis lease ownership, and critical local fallback.
- `lib/wallet-balance-alerts.ts`: distinct low-balance and wallet-source alerts.
- `lib/health-monitor.ts`: nullable source-aware snapshot, anomaly evaluation, reserve timer, and top-level failure page.
- `app/api/health/wallet/route.ts`, `app/api/cron/wallet-health/route.ts`, and `app/admin/(protected)/status-health/page.tsx`: external/operator presentation.
- `.env.local.example` and `docs/stellar-cold-reserve-runbook.md`: deployment settings, schedule, and simulations.
- Existing colocated `__tests__` files plus new `app/api/health/wallet/__tests__/route.test.ts`: executable acceptance coverage.

---

### Task 1: Record Accepted Payments on `PayoutJob`

**Files:**
- Modify: `prisma/schema.prisma:288-317`
- Create: `prisma/migrations/20260908090000_add_payout_broadcast_monitoring/migration.sql`
- Modify: `lib/payout-worker.ts:175-188,345-405`
- Modify: `lib/payout-service.ts:146-158`
- Modify: `lib/__tests__/payout-worker.test.ts`
- Modify: `lib/__tests__/payout-worker-lump-sum.test.ts`
- Modify: `lib/__tests__/payout-service.test.ts`

**Interfaces:**
- Consumes: Stellar `payReward(...): Promise<string>` and existing `PayoutJob.amountUnits`/`txHash` fields.
- Produces: nullable Prisma field `PayoutJob.broadcastAt: Date | null`; every accepted payment has non-null `txHash`, `amountUnits`, and `broadcastAt`.

- [ ] **Step 1: Add failing persistence assertions for both worker flows**

In the successful submission and withdrawal worker tests, capture a timestamp immediately before `processJob` and assert the persisted tuple:

```ts
const beforeBroadcast = new Date();
await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");
const updatedJob = await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } });
expect(updatedJob.txHash).toBe(TX_HASH);
expect(updatedJob.amountUnits).toBe(AMOUNT_UNITS);
expect(updatedJob.broadcastAt?.getTime()).toBeGreaterThanOrEqual(beforeBroadcast.getTime());
```

Add the equivalent assertion to the successful `WITHDRAWAL` test using its job ID and amount.

- [ ] **Step 2: Add a failing legacy retry assertion**

Extend the payout-service Prisma mock with `mockPayoutJobUpsert`, then assert a successful retry creates or updates its linked job:

```ts
expect(mockPayoutJobUpsert).toHaveBeenCalledWith({
  where: { submissionId: "sub-4" },
  create: expect.objectContaining({
    type: "SUBMISSION_PAYOUT",
    submissionId: "sub-4",
    amountUnits: 500n,
    txHash: TX_1,
    broadcastAt: expect.any(Date),
    status: "done",
  }),
  update: expect.objectContaining({
    amountUnits: 500n,
    txHash: TX_1,
    broadcastAt: expect.any(Date),
    status: "done",
  }),
});
```

- [ ] **Step 3: Run the focused tests and verify the new assertions fail**

```bash
npm test -- lib/__tests__/payout-worker.test.ts lib/__tests__/payout-worker-lump-sum.test.ts lib/__tests__/payout-service.test.ts
```

Expected: FAIL because `broadcastAt` is absent and the legacy retry never writes `PayoutJob`.

- [ ] **Step 4: Add the schema field, backfill, and indexes**

Add to `PayoutJob`:

```prisma
broadcastAt DateTime?

@@index([broadcastAt])
@@index([status, completedAt])
```

Create the migration with exact SQL:

```sql
ALTER TABLE "payout_jobs" ADD COLUMN "broadcastAt" TIMESTAMP(3);

UPDATE "payout_jobs" AS job
SET
  "amountUnits" = COALESCE(job."amountUnits", submission."payoutAmountUnits"),
  "txHash" = COALESCE(job."txHash", submission."payoutTxHash")
FROM "submissions" AS submission
WHERE job."submissionId" = submission."id";

UPDATE "payout_jobs"
SET "broadcastAt" = COALESCE("completedAt", "updatedAt", "createdAt")
WHERE "txHash" IS NOT NULL AND "broadcastAt" IS NULL;

CREATE INDEX "payout_jobs_broadcastAt_idx" ON "payout_jobs"("broadcastAt");
CREATE INDEX "payout_jobs_status_completedAt_idx" ON "payout_jobs"("status", "completedAt");
```

- [ ] **Step 5: Persist the broadcast tuple in both worker paths**

Use one timestamp per accepted transaction:

```ts
const broadcastAt = new Date();
await prisma.payoutJob.update({
  where: { id: jobId },
  data: { txHash, amountUnits, broadcastAt, workerHeartbeatAt: broadcastAt },
});
```

Inside the submission worker's existing transaction, update the job before user/ledger writes:

```ts
await tx.payoutJob.update({
  where: { id: jobId },
  data: { txHash, amountUnits: amount, broadcastAt },
});
```

- [ ] **Step 6: Persist a legacy retry atomically with its submission result**

Replace the standalone post-broadcast submission update with:

```ts
const broadcastAt = new Date();
await prisma.$transaction(async (tx) => {
  await tx.submission.update({
    where: { id: submissionId },
    data: { payoutStatus: "sent", payoutTxHash: txHash, lastRetriedAt: broadcastAt },
  });
  await tx.payoutJob.upsert({
    where: { submissionId },
    create: {
      type: "SUBMISSION_PAYOUT",
      submissionId,
      amountUnits: amount,
      txHash,
      broadcastAt,
      status: "done",
      completedAt: broadcastAt,
    },
    update: {
      amountUnits: amount,
      txHash,
      broadcastAt,
      status: "done",
      completedAt: broadcastAt,
      lastError: null,
    },
  });
});
```

If this database write fails after Horizon accepts payment, log only the error class; do not mark the job failed or retry from that catch path.

- [ ] **Step 7: Generate Prisma code and run focused verification**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/centient npm exec prisma generate
npm test -- lib/__tests__/payout-worker.test.ts lib/__tests__/payout-worker-lump-sum.test.ts lib/__tests__/payout-service.test.ts
npm run typecheck
```

Expected: generation succeeds and all focused checks pass.

- [ ] **Step 8: Commit the broadcast ledger**

```bash
git add prisma/schema.prisma prisma/migrations/20260908090000_add_payout_broadcast_monitoring/migration.sql app/generated/prisma lib/payout-worker.ts lib/payout-service.ts lib/__tests__/payout-worker.test.ts lib/__tests__/payout-worker-lump-sum.test.ts lib/__tests__/payout-service.test.ts
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "feat(payouts): record accepted payment broadcasts"
```

---

### Task 2: Derive Payout Activity and Cap Spend from Broadcast Jobs

**Files:**
- Modify: `lib/payout-cap.ts`
- Modify: `lib/__tests__/payout-cap.test.ts`
- Create: `lib/__tests__/payout-cap-db.test.ts`
- Modify: `lib/__tests__/health-monitor.test.ts`

**Interfaces:**
- Consumes: `PayoutJob.broadcastAt`, `amountUnits`, and `txHash` from Task 1.
- Produces: `getPayoutActivitySince(since: Date): Promise<{ count: number; volumeUnits: bigint }>` and the existing `getRolling24hPayoutSum(): Promise<bigint>` backed by payout jobs.

- [ ] **Step 1: Replace submission-shaped mocks with payout-job expectations**

Write tests that require this exact filter:

```ts
expect(mockPayoutJobAggregate).toHaveBeenCalledWith({
  _count: { _all: true },
  _sum: { amountUnits: true },
  where: {
    status: { in: ["processing", "done"] },
    broadcastAt: { gte: since },
    txHash: { not: null },
    amountUnits: { not: null },
  },
});
expect(result).toEqual({ count: 2, volumeUnits: 750_000_000n });
```

Update every cap test to mock `prisma.payoutJob.aggregate` instead of `prisma.submission.aggregate`.
Add a database-backed test using `tests/helpers/db.ts` that inserts recent
`processing` and `done` withdrawal jobs plus queued, permanently failed, and
out-of-window controls, then asserts only the first two contribute to count and
volume.

- [ ] **Step 2: Run the payout-cap tests and verify they fail**

```bash
npm test -- lib/__tests__/payout-cap.test.ts
```

Expected: FAIL because the shared function and payout-job query do not exist.

- [ ] **Step 3: Implement the shared activity query**

```ts
export interface PayoutActivity {
  count: number;
  volumeUnits: bigint;
}

export async function getPayoutActivitySince(since: Date): Promise<PayoutActivity> {
  const result = await prisma.payoutJob.aggregate({
    _count: { _all: true },
    _sum: { amountUnits: true },
    where: {
      status: { in: ["processing", "done"] },
      broadcastAt: { gte: since },
      txHash: { not: null },
      amountUnits: { not: null },
    },
  });
  return {
    count: result._count._all,
    volumeUnits: result._sum.amountUnits ?? 0n,
  };
}
```

Implement `getRolling24hPayoutSum` by calling `getPayoutActivitySince(new Date(Date.now() - 86_400_000))` and returning `volumeUnits`.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
npm test -- lib/__tests__/payout-cap.test.ts lib/__tests__/payout-cap-db.test.ts
npm run typecheck
```

Expected: all focused checks pass.

- [ ] **Step 5: Commit the accounting correction**

```bash
git add lib/payout-cap.ts lib/__tests__/payout-cap.test.ts lib/__tests__/payout-cap-db.test.ts
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "fix(payouts): account for broadcast payout jobs"
```

---

### Task 3: Calculate Exact Spendable XLM from Horizon Protocol Data

**Files:**
- Modify: `lib/stellar/balance.ts`
- Modify: `lib/stellar/__tests__/balance.test.ts`
- Modify: `lib/wallet-balance-alerts.ts`

**Interfaces:**
- Consumes: Horizon account fields `subentry_count`, `num_sponsoring`, `num_sponsored`, native `selling_liabilities`, and latest-ledger `base_reserve_in_stroops`.
- Produces: `calculateSpendableXlm(...)`, `WalletHealth.monitoringStatus`, `baseReserveXlm`, `minimumBalanceXlm`, `nativeSellingLiabilitiesXlm`, `numSubentries`, and `numSponsored`.

- [ ] **Step 1: Add failing exact-reserve tests**

Mock `server()` with both account and latest-ledger reads:

```ts
const mockLedgerCall = vi.fn().mockResolvedValue({
  records: [{ base_reserve_in_stroops: "5000000" }],
});
const mockServer = {
  loadAccount: mockLoadAccount,
  ledgers: () => ({
    order: () => ({ limit: () => ({ call: mockLedgerCall }) }),
  }),
};
```

Cover this calculation: 10 XLM total, 1 XLM native selling liabilities, base reserve 0.5 XLM, `subentry_count=2`, `num_sponsoring=3`, and `num_sponsored=1` yields a 3 XLM minimum balance and 6 XLM spendable. Add separate assertions for sponsorship offset, exact seven-decimal parsing, and a zero floor.

- [ ] **Step 2: Add failing monitoring-state tests**

Assert missing/invalid `STELLAR_PLATFORM_SECRET` returns `monitoringStatus: "unconfigured"`, while a rejected Horizon call returns `monitoringStatus: "error"`; both keep balances as `"—"` and asset statuses as `unknown`.

- [ ] **Step 3: Run balance tests and verify they fail**

```bash
npm test -- lib/stellar/__tests__/balance.test.ts
```

Expected: FAIL because live reserve, liabilities, and monitoring fields are not used.

- [ ] **Step 4: Implement exact stroop arithmetic and the live ledger read**

```ts
export function calculateSpendableXlm({
  totalStroops,
  sellingLiabilitiesStroops,
  baseReserveStroops,
  subentryCount,
  numSponsoring,
  numSponsored,
}: SpendableXlmInput): { minimumBalanceStroops: bigint; spendableStroops: bigint } {
  const reserveUnits = Math.max(0, 2 + subentryCount + numSponsoring - numSponsored);
  const minimumBalanceStroops = baseReserveStroops * BigInt(reserveUnits);
  const raw = totalStroops - sellingLiabilitiesStroops - minimumBalanceStroops;
  return { minimumBalanceStroops, spendableStroops: raw > 0n ? raw : 0n };
}
```

Load account and latest ledger in parallel after deriving the platform address. Match USDC by configured code/issuer and read `selling_liabilities` from the native balance line. Format display fields only after exact bigint calculation.

- [ ] **Step 5: Emit source alerts instead of skipping unknown wallet data**

Update `walletBalanceAlerts`:

```ts
if (health.monitoringStatus === "unconfigured") {
  return [{
    key: "wallet-monitoring-unconfigured",
    severity: "WARN",
    title: "Wallet monitoring is not configured",
    lines: ["Configure the Stellar platform wallet before relying on balance alerts"],
  }];
}
if (health.monitoringStatus === "error") {
  return [{
    key: "wallet-monitoring-unavailable",
    severity: "PAGE",
    title: "Wallet monitoring is unavailable",
    lines: [`Platform wallet: ${health.address}`],
  }];
}
```

Retain distinct `wallet-usdc-warn/page` and `wallet-xlm-warn/page` identities for successful source reads.

- [ ] **Step 6: Run focused verification and commit**

```bash
npm test -- lib/stellar/__tests__/balance.test.ts
npm run typecheck
git add lib/stellar/balance.ts lib/stellar/__tests__/balance.test.ts lib/wallet-balance-alerts.ts
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "fix(stellar): calculate spendable XLM reserves"
```

---

### Task 4: Make Discord Deduplication Ownership-Safe and Bounded

**Files:**
- Modify: `lib/health-alert.ts`
- Modify: `lib/__tests__/health-alert.test.ts`

**Interfaces:**
- Consumes: ioredis `set`/`eval`, global `fetch`, `HealthAlert.severity`, `HEALTH_ALERT_COOLDOWN_MS`, and `HEALTH_ALERT_DELIVERY_TIMEOUT_MS`.
- Produces: `HealthAlertDelivery` values `disabled | failed | sent | suppressed | sent-degraded | suppressed-degraded`.

- [ ] **Step 1: Write failing lease and fallback tests**

Cover these observable calls:

```ts
expect(mockSet).toHaveBeenCalledWith(redisKey, expect.any(String), "PX", 30_000, "NX");
expect(mockEval).toHaveBeenCalledWith(
  expect.stringContaining("psetex"),
  1,
  redisKey,
  token,
  "900000",
);
expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
```

Also test that a failed webhook invokes compare-delete Lua instead of `redis.del`, an ownership mismatch leaves the newer lease intact, Redis failure suppresses WARN without fetching, and two PAGE calls during Redis failure return `sent-degraded` then `suppressed-degraded` with one fetch.

- [ ] **Step 2: Run alert tests and verify they fail**

```bash
npm test -- lib/__tests__/health-alert.test.ts
```

Expected: FAIL because the cooldown doubles as the delivery lock, has no ownership token/timeout, and drops every alert on Redis failure.

- [ ] **Step 3: Implement lease scripts and timeout parsing**

Use a 30-second lease, `crypto.randomUUID()`, and:

```ts
const PROMOTE_OWNED_LEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("psetex", KEYS[1], ARGV[2], ARGV[1])
end
return 0`;

const DELETE_OWNED_LEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;
```

Parse `HEALTH_ALERT_DELIVERY_TIMEOUT_MS` as a positive integer capped below 30 seconds, defaulting to 10 seconds. Pass `AbortSignal.timeout(timeoutMs)` to `fetch`.

- [ ] **Step 4: Add the bounded PAGE fallback**

Maintain a module-local `Map<string, number>` keyed by alert key. On Redis failure, WARN returns `failed`; PAGE checks the local expiry, delivers once, records `nowMs + cooldownMs` only on success, and returns the degraded result. Delete expired entries when checking a key so the map remains bounded by active alert identities.

- [ ] **Step 5: Run focused verification and commit**

```bash
npm test -- lib/__tests__/health-alert.test.ts lib/__tests__/payout-cap.test.ts
npm run typecheck
git add lib/health-alert.ts lib/__tests__/health-alert.test.ts
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "fix(ops): harden alert delivery leases"
```

---

### Task 5: Build a Source-Aware Health Snapshot and Failure Alerts

**Files:**
- Modify: `lib/health-monitor.ts`
- Modify: `lib/__tests__/health-monitor.test.ts`
- Modify: `app/api/cron/wallet-health/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getPayoutActivitySince`, `getRolling24hPayoutSum`, `getWalletHealth`, `parseReserveRefillPolicy`, `loadReserveRefillStatus`, and `sendDedupedDiscordAlert`.
- Produces: `MonitoringStatus = "healthy" | "unconfigured" | "error"`; nullable metrics; `sourceStatus: { wallet; payouts; reserve; refillTimer }`; monitoring alerts and top-level failure delivery.

- [ ] **Step 1: Rewrite snapshot fixtures around nullable, source-aware metrics**

Use this public shape in tests:

```ts
metrics: {
  payoutCount: 100,
  payoutVolumeUnits: "1000000000",
  failedPayoutCount: 3,
  dailyCapUnits: "2000000000",
  dailySpentUnits: "1600000000",
  dailyCapPercent: 80,
  reserveStatus: "refill_required",
  hotBalanceUnits: "250000000",
  coldBalanceUnits: "2000000000",
  refillDueSince: "2026-09-07T23:29:00.000Z",
  sourceStatus: {
    wallet: "healthy",
    payouts: "healthy",
    reserve: "healthy",
    refillTimer: "healthy",
  },
}
```

Add failure tests in which payout queries reject and return null payout/count/spend metrics plus `payout-monitoring-unavailable`; reserve configuration is absent and returns `reserve-monitoring-unconfigured`; reserve Horizon lookup rejects and returns `reserve-monitoring-unavailable`; refill Redis rejects and returns `refill-timer-unavailable`.

- [ ] **Step 2: Add a failing top-level snapshot failure test**

Force an unexpected snapshot exception through a mocked dependency and assert `runHealthMonitor` attempts one page before rethrowing:

```ts
await expect(runHealthMonitor()).rejects.toThrow();
expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({
  key: "health-monitor-unavailable",
  severity: "PAGE",
}));
```

- [ ] **Step 3: Run focused monitor tests and verify they fail**

```bash
npm test -- lib/__tests__/health-monitor.test.ts app/api/cron/wallet-health/__tests__/route.test.ts
```

Expected: FAIL because source failures currently become `unconfigured`, zeros, or uncaught errors without a monitoring page.

- [ ] **Step 4: Add typed source loaders**

```ts
export type MonitoringStatus = "healthy" | "unconfigured" | "error";

type NullablePayoutMetrics = {
  payoutCount: number | null;
  payoutVolumeUnits: bigint | null;
  failedPayoutCount: number | null;
  dailySpentUnits: bigint | null;
  status: MonitoringStatus;
};
```

`loadPayoutMetrics` queries activity, daily spend, and recent failed jobs in parallel and catches the group as `status: "error"` with every value null. `loadReserveStatus` validates with `parseReserveRefillPolicy(process.env)` first; validation failure is `unconfigured`, while lookup failure after valid configuration is `error`.

- [ ] **Step 5: Make alert evaluation nullable and source-aware**

Guard numeric comparisons with null checks and append stable source alerts:

```ts
if (input.payoutStatus === "error") {
  alerts.push({
    key: "payout-monitoring-unavailable",
    severity: "PAGE",
    title: "Payout monitoring is unavailable",
    lines: ["Rolling payout and failure metrics could not be loaded"],
  });
}
```

Use corresponding keys `reserve-monitoring-unconfigured`, `reserve-monitoring-unavailable`, and `refill-timer-unavailable`. Do not evaluate threshold alerts for a null source metric.

- [ ] **Step 6: Preserve independent snapshot results**

Collect wallet, payout, and reserve loaders with `Promise.all`; each loader returns a state instead of throwing. Set nullable JSON metrics and calculate `dailyCapPercent` only when cap and spend are available. The refill marker returns `{ dueSinceMs, status }`, with `error` when Redis fails.

- [ ] **Step 7: Page on an unexpected top-level failure**

Wrap snapshot assembly in `runHealthMonitor`:

```ts
let snapshot: HealthMonitorSnapshot;
try {
  snapshot = await getHealthMonitorSnapshot(options);
} catch (error) {
  await sendDedupedDiscordAlert({
    key: "health-monitor-unavailable",
    severity: "PAGE",
    title: "Wallet-health monitor failed",
    lines: ["The health snapshot could not be assembled"],
  });
  throw error;
}
```

Keep route error bodies generic and log only `error.name`/`typeof error`.

- [ ] **Step 8: Run focused verification and commit**

```bash
npm test -- lib/__tests__/health-monitor.test.ts app/api/cron/wallet-health/__tests__/route.test.ts
npm run typecheck
git add lib/health-monitor.ts lib/__tests__/health-monitor.test.ts app/api/cron/wallet-health/__tests__/route.test.ts
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "feat(ops): expose health monitor source states"
```

---

### Task 6: Expose the Same Health Contract to API and Admin Operators

**Files:**
- Create: `app/api/health/wallet/__tests__/route.test.ts`
- Modify: `app/api/health/wallet/route.ts`
- Modify: `app/admin/(protected)/status-health/page.tsx`
- Modify: `app/admin/(protected)/status-health/__tests__/page.test.ts`

**Interfaces:**
- Consumes: `WalletHealth` from Task 3 and `HealthMonitorSnapshot` from Task 5.
- Produces: JSON-safe public wallet fields and an admin view that renders unavailable values as `—` with source alerts visible.

- [ ] **Step 1: Add the failing public route contract test**

Mock `getWalletHealth` and require existing fields plus:

```ts
expect(await response.json()).toMatchObject({
  availableXlmBalance: "6.0000",
  baseReserveXlm: "0.5000",
  minimumBalanceXlm: "3.0000",
  nativeSellingLiabilitiesXlm: "1.0000",
  numSubentries: 2,
  numSponsoring: 3,
  numSponsored: 1,
  monitoringStatus: "healthy",
  assetStatus: { usdc: "healthy", xlm: "healthy" },
});
```

- [ ] **Step 2: Add failing admin rendering assertions**

Assert the healthy fixture shows `10.0000 XLM total; 3.0000 minimum; 1.0000 liabilities`, while an error fixture with null payout metrics shows `—` and the `Payout monitoring is unavailable` alert rather than `0 payouts`.

- [ ] **Step 3: Run route/page tests and verify they fail**

```bash
npm test -- app/api/health/wallet/__tests__/route.test.ts app/admin/\(protected\)/status-health/__tests__/page.test.ts
```

Expected: FAIL because the public endpoint omits fields and the page assumes every payout metric is numeric.

- [ ] **Step 4: Extend the public wallet response**

```ts
return NextResponse.json({
  address: health.address,
  usdcBalance: health.usdcBalance,
  rewardTokenSymbol: health.rewardTokenSymbol,
  xlmBalance: health.xlmBalance,
  availableXlmBalance: health.availableXlmBalance,
  baseReserveXlm: health.baseReserveXlm,
  minimumBalanceXlm: health.minimumBalanceXlm,
  nativeSellingLiabilitiesXlm: health.nativeSellingLiabilitiesXlm,
  numSubentries: health.numSubentries,
  numSponsoring: health.numSponsoring,
  numSponsored: health.numSponsored,
  monitoringStatus: health.monitoringStatus,
  assetStatus: health.assetStatus,
  healthy: health.healthy,
  warnings: health.warnings,
  pages: health.pages,
});
```

- [ ] **Step 5: Render null-safe admin cards and source status**

Update the formatter to accept `string | null`, render payout count/failures/percent as `—` when null, and show total/minimum/liability/spendable XLM in the hot-wallet card. Keep monitoring alerts in the existing rail-health banner so unavailable sources are visible above the cards.

- [ ] **Step 6: Run focused verification and commit**

```bash
npm test -- app/api/health/wallet/__tests__/route.test.ts app/admin/\(protected\)/status-health/__tests__/page.test.ts app/api/cron/wallet-health/__tests__/route.test.ts
npm run typecheck
git add app/api/health/wallet/route.ts app/api/health/wallet/__tests__/route.test.ts app/admin/\(protected\)/status-health/page.tsx app/admin/\(protected\)/status-health/__tests__/page.test.ts
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "feat(admin): surface complete rail health"
```

---

### Task 7: Document Configuration, Schedule, and Alert Simulations

**Files:**
- Modify: `.env.local.example`
- Modify: `docs/stellar-cold-reserve-runbook.md`

**Interfaces:**
- Consumes: every environment variable and alert identity implemented in Tasks 3-5.
- Produces: one accurate Stellar-only configuration reference and reproducible operator checks for issue #11 acceptance.

- [ ] **Step 1: Replace obsolete wallet/cap comments and settings**

Replace `BALANCE_WARN_CELO`, `BALANCE_PAGE_CELO`, `BALANCE_WARN_REWARD`, and
`BALANCE_PAGE_REWARD` with the active dual-asset thresholds. Retain legacy chain
variables that still have consumers elsewhere in the application and label them
accurately rather than expanding issue #11 into their removal. Document:

```dotenv
BALANCE_WARN_USDC=50
BALANCE_PAGE_USDC=10
BALANCE_WARN_XLM=5
BALANCE_PAGE_XLM=2
# HEALTH_PAYOUT_WINDOW_MINUTES=60
# HEALTH_PAYOUT_COUNT_THRESHOLD=100
# HEALTH_PAYOUT_VOLUME_UNITS_THRESHOLD=1000000000
# HEALTH_FAILURE_WINDOW_MINUTES=15
# HEALTH_FAILURE_COUNT_THRESHOLD=3
# HEALTH_CAP_PERCENT_THRESHOLD=80
# HEALTH_REFILL_OVERDUE_MINUTES=30
# HEALTH_ALERT_COOLDOWN_MS=900000
# HEALTH_ALERT_DELIVERY_TIMEOUT_MS=10000
```

Correct remaining reward/cap/fee comments to say USDC and seven-decimal Stellar units.

- [ ] **Step 2: Add runbook simulations and scheduling**

Document authenticated invocation:

```bash
curl -X POST https://APP_HOST/api/cron/wallet-health \
  -H "Authorization: Bearer $CRON_SECRET"
```

Add separate test-environment procedures for lowering USDC below `BALANCE_PAGE_USDC`, lowering spendable XLM below `BALANCE_PAGE_XLM`, setting an anomaly threshold below current observed activity, and repeating the request within `HEALTH_ALERT_COOLDOWN_MS` to verify delivery is suppressed. State that production scheduling invokes the endpoint at least once per minute.

- [ ] **Step 3: Check documentation consistency**

```bash
rg -n "BALANCE_WARN_CELO|BALANCE_PAGE_CELO|BALANCE_WARN_REWARD|BALANCE_PAGE_REWARD|200 XLM|0.15 XLM" .env.local.example docs/stellar-cold-reserve-runbook.md
```

Expected: no obsolete active configuration or XLM-denominated USDC comments remain.

- [ ] **Step 4: Commit operator documentation**

```bash
git add .env.local.example docs/stellar-cold-reserve-runbook.md
git -c user.name=cemmacabales -c user.email=carlmacabales31@gmail.com commit -m "docs: add wallet health operations guide"
```

---

### Task 8: Full Verification, Review, Push, and PR

**Files:**
- Review: all files changed from `origin/develop...HEAD`
- Modify only if verification or review identifies a concrete defect.

**Interfaces:**
- Consumes: completed Tasks 1-7.
- Produces: verified branch and pull request against `develop` satisfying issue #11.

- [ ] **Step 1: Validate migration and generated client**

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/centient npm exec prisma validate
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/centient npm exec prisma generate
git diff --check
```

Expected: schema valid, client generated, and no whitespace errors.

- [ ] **Step 2: Run the complete automated suite**

```bash
npm test
npm run typecheck
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/centient npm run build
```

Expected: all tests pass, TypeScript exits zero, and the production build succeeds. Record pre-existing non-fatal Next.js warnings separately.

- [ ] **Step 3: Review the complete diff for security and operational correctness**

```bash
git diff --stat origin/develop...HEAD
git diff --check origin/develop...HEAD
git log --format='%h %an <%ae> %s' origin/develop..HEAD
```

Confirm no secrets, webhook URLs, seed phrases, co-author trailers, zero-valued unavailable metrics, Submission-based cap queries, or unconditional Redis lease deletes appear in the diff.

- [ ] **Step 4: Request an independent code review at the current HEAD**

Use the requesting-code-review workflow against `origin/develop...HEAD`. Address each confirmed critical/important issue with a test-first fix, rerun focused tests, commit with the required identity, and repeat review if HEAD changes.

- [ ] **Step 5: Run the required external review at the final commit**

Invoke the installed read-only review CLI with the exact final SHA and ask it to inspect `origin/develop...HEAD` for payout accounting, Stellar reserve math, monitoring failure semantics, Redis ownership races, secret exposure, and missing tests. If it identifies a confirmed defect, fix it test-first and rerun this step at the new SHA.

- [ ] **Step 6: Re-run completion verification after final review**

```bash
npm test
npm run typecheck
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/centient npm run build
git status --short
```

Expected: all commands pass and the worktree is clean.

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin codex/feat-issue-11-wallet-health
gh pr create --base develop --head codex/feat-issue-11-wallet-health \
  --title "feat: add dual-asset wallet health monitoring" \
  --body "Implements durable payout-job accounting, exact spendable-XLM reserve math, source-aware health reporting, and deduplicated anomaly alerts.\n\nCloses #11"
```

- [ ] **Step 8: Confirm remote checks and report the handoff**

```bash
gh pr checks --watch
gh pr view --json url,state,mergeable,headRefOid,baseRefName
```

Expected: checks pass, base is `develop`, and `headRefOid` equals local `HEAD`.
