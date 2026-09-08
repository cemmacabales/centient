import { requireRoleForPage } from "@/lib/admin-auth";
import { getHealthSnapshot, isStuckPending } from "@/lib/admin-data";
import { getHealthMonitorSnapshot } from "@/lib/health-monitor";
import StatCard from "@/components/admin/StatCard";

export const dynamic = "force-dynamic";

function unitsToFourDecimalUsdc(units: string | null): string {
  if (units === null) return "—";
  const value = BigInt(units);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0").slice(0, 4);
  return `${whole}.${fraction}`;
}

function reserveStatusLabel(status: string | null): string {
  if (status === null) return "—";
  const words = status.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export default async function AdminStatusHealthPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const [snap, railHealth] = await Promise.all([
    getHealthSnapshot(),
    getHealthMonitorSnapshot(),
  ]);
  const walletHealth = railHealth.wallet;
  const stuck = snap.pendingOldestAt ? isStuckPending(snap.pendingOldestAt) : false;
  const stuckAgeMs = snap.pendingOldestAt
    ? Date.now() - snap.pendingOldestAt.getTime()
    : 0;
  const stuckAgeMin = Math.floor(stuckAgeMs / 60000);

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          System health
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Status
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          Wallet funding, payout anomalies, reserve readiness, and queue health. Refreshes on every
          page load.
        </p>
      </header>

      {stuck && (
        <div className="rounded-2xl border border-error/40 bg-error-container p-4 text-on-error-container">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-[24px]" aria-hidden="true">
              warning
            </span>
            <div>
              <div className="font-headline text-sm font-bold">Stuck payout detected</div>
              <p className="mt-1 font-body text-sm">
                The oldest pending submission is {stuckAgeMin} minute{stuckAgeMin === 1 ? "" : "s"} old
                (threshold: {Math.floor(snap.stuckPayoutThresholdMs / 60000)} min). The cron retry job
                (app/api/cron/payout-retry) will automatically reprocess stuck submissions; the
                reconciler confirms on-chain receipts and marks them confirmed/failed. Admins can also
                manually retry individual submissions from the user profile view.
              </p>
            </div>
          </div>
        </div>
      )}

      {railHealth.alerts.length > 0 && (
        <div className="rounded-2xl border border-error/40 bg-error-container p-4 text-on-error-container">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-[24px]" aria-hidden="true">
              account_balance_wallet
            </span>
            <div>
              <div className="font-headline text-sm font-bold">Rail health needs attention</div>
              <ul className="mt-2 space-y-1 font-body text-sm">
                {railHealth.alerts.map((alert) => (
                  <li key={alert.key}>
                    <span className="font-semibold">{alert.title}</span>
                    {alert.lines[0] ? ` — ${alert.lines[0]}` : ""}
                  </li>
                ))}
              </ul>
              <a
                href="/api/health/wallet"
                target="_blank"
                className="mt-2 inline-block text-xs underline hover:no-underline"
              >
                /api/health/wallet
              </a>
            </div>
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          Hot wallet
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard
            label="Hot-wallet address"
            value={
              walletHealth.address === "—"
                ? "—"
                : `${walletHealth.address.slice(0, 6)}…${walletHealth.address.slice(-4)}`
            }
            subline={
              walletHealth.address === "—"
                ? "Stellar wallet not configured"
                : "Stellar platform hot wallet"
            }
          />
          <StatCard
            label={`${snap.rewardSymbol} balance`}
            value={
              walletHealth.usdcBalance === "—"
                ? "—"
                : `${walletHealth.usdcBalance} ${snap.rewardSymbol}`
            }
            subline={
              walletHealth.usdcBalance === "—"
                ? "Horizon lookup failed or wallet not configured"
                : `Warning: <${walletHealth.thresholds.warnUsdc} | Page: <${walletHealth.thresholds.pageUsdc}`
            }
          />
          <StatCard
            label="XLM (fees/reserve) balance"
            value={
              walletHealth.availableXlmBalance === "—"
                ? "—"
                : `${walletHealth.availableXlmBalance} XLM spendable`
            }
            subline={
              walletHealth.availableXlmBalance === "—"
                ? "Horizon lookup failed"
                : `${walletHealth.xlmBalance} XLM total; ${walletHealth.minimumBalanceXlm} minimum; ${walletHealth.nativeSellingLiabilitiesXlm} liabilities · Warning: <${walletHealth.thresholds.warnXlm} | Page: <${walletHealth.thresholds.pageXlm}`
            }
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          Rail alerts
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Payout activity"
            value={railHealth.metrics.payoutCount === null ? "—" : `${railHealth.metrics.payoutCount} payouts`}
            subline={`${unitsToFourDecimalUsdc(railHealth.metrics.payoutVolumeUnits)} USDC in ${railHealth.thresholds.payoutWindowMinutes} min`}
          />
          <StatCard
            label="Daily payout cap"
            value={railHealth.metrics.dailyCapPercent === null ? "—" : `${railHealth.metrics.dailyCapPercent}% used`}
            subline={`${unitsToFourDecimalUsdc(railHealth.metrics.dailySpentUnits)} of ${unitsToFourDecimalUsdc(railHealth.metrics.dailyCapUnits)} USDC`}
          />
          <StatCard
            label="Permanent failures"
            value={railHealth.metrics.failedPayoutCount === null ? "—" : `${railHealth.metrics.failedPayoutCount} failures`}
            subline={`Last ${railHealth.thresholds.failureWindowMinutes} min · Alert at ${railHealth.thresholds.failureCountThreshold}`}
          />
          <StatCard
            label="Cold reserve"
            value={reserveStatusLabel(railHealth.metrics.reserveStatus)}
            subline={
              railHealth.metrics.coldBalanceUnits === null
                ? "Reserve monitoring not configured"
                : `${unitsToFourDecimalUsdc(railHealth.metrics.coldBalanceUnits)} USDC reserve${
                    railHealth.metrics.refillDueSince
                      ? ` · Due since ${new Date(railHealth.metrics.refillDueSince).toLocaleString()}`
                      : ""
                  }`
            }
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          Payout queue
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="Pending"
            value={String(snap.pendingSubmissions)}
            subline={
              snap.pendingOldestAt
                ? `Oldest: ${Math.floor((Date.now() - snap.pendingOldestAt.getTime()) / 60000)} min ago`
                : "No pending submissions"
            }
          />
          <StatCard
            label="Failed (total)"
            value={String(snap.failedSubmissions)}
            subline={`${snap.failedLast24h} in the last 24h`}
          />
          <StatCard
            label="Abandoned"
            value={String(snap.abandonedSubmissions)}
            subline="Exhausted all 5 retry attempts"
          />
          <StatCard
            label="Total users"
            value={String(snap.totalUsers)}
            subline={`${snap.bannedUsers} banned`}
          />
          <StatCard
            label="Gold pool"
            value={String(snap.totalPlatformGoldTasks)}
            subline={`Platform gold tasks available for ${snap.rewardSymbol} on Stellar`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          Task pool
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard
            label="Total tasks"
            value={String(snap.totalTasks)}
            subline="All Task rows in the database"
          />
          <StatCard
            label="Campaign tasks"
            value={String(snap.totalCampaignTasks)}
            subline="Belongs to a customer campaign"
          />
          <StatCard
            label="Platform gold"
            value={String(snap.totalPlatformGoldTasks)}
            subline="`isGold=true AND campaignId IS NULL`"
          />
        </div>
      </section>
    </div>
  );
}
