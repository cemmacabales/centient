import ExportButton from "@/components/admin/ExportButton";
import StatCard from "@/components/admin/StatCard";
import {
  getDashboardTotals,
  getRecentActivity,
  truncateAddress,
} from "@/lib/admin-data";

export const dynamic = "force-dynamic";

function formatDateTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export default async function AdminDashboardPage() {
  const [totals, activity] = await Promise.all([
    getDashboardTotals(),
    getRecentActivity(10),
  ]);

  return (
    <div className="space-y-8">
      <header>
	<ExportButton />
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Operator overview
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Dashboard
        </h1>
      </header>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total submissions"
          value={totals.totalSubmissions.toLocaleString()}
          subline={`${totals.totalPaidSubmissions.toLocaleString()} sent · ${totals.totalFailedSubmissions.toLocaleString()} failed`}
        />
        <StatCard
          label="Total paid out"
          value={`${totals.totalPaidOut} ${totals.rewardSymbol}`}
          subline={`across ${totals.totalPaidSubmissions.toLocaleString()} payouts`}
        />
        <StatCard
          label="Hot wallet balance"
          value={`${totals.hotWalletBalance} ${totals.rewardSymbol}`}
          subline={truncateAddress(totals.hotWalletAddress)}
        />
        <StatCard
          label="Active wallets"
          value={totals.uniqueWallets.toLocaleString()}
          subline={`${totals.bannedWallets.toLocaleString()} paused`}
        />
      </div>

      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <h2 className="font-headline text-lg font-bold text-on-surface">Recent activity</h2>
        <p className="mt-1 font-body text-sm text-on-surface-variant">
          Last 10 submissions across all wallets.
        </p>
        {activity.length === 0 ? (
          <div className="mt-6 rounded-xl bg-surface-container-low p-6 text-center font-body text-sm text-on-surface-variant">
            No submissions yet.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="font-label text-xs font-bold uppercase tracking-wider text-outline">
                  <th className="py-2 pr-4">Wallet</th>
                  <th className="py-2 pr-4">Task</th>
                  <th className="py-2 pr-4">Choice</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Submitted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {activity.map((row) => (
                  <tr key={row.id}>
                    <td className="py-3 pr-4 font-mono text-xs text-on-surface">
                      {truncateAddress(row.walletAddress)}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs text-on-surface-variant">
                      {row.taskId}
                    </td>
                    <td className="py-3 pr-4 font-label text-sm font-semibold text-on-surface">
                      {row.choice}
                    </td>
                    <td className="py-3 pr-4">
                      <PayoutStatusChip status={row.payoutStatus} />
                    </td>
                    <td className="py-3 font-body text-xs text-on-surface-variant">
                      {formatDateTime(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PayoutStatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    sent: "bg-primary-container/40 text-on-primary-container",
    pending: "bg-surface-container-high text-on-surface-variant",
    skipped: "bg-surface-container-high text-on-surface-variant",
    failed: "bg-error-container text-on-error-container",
  };
  const cls = styles[status] ?? "bg-surface-container-high text-on-surface-variant";
  return (
    <span className={`rounded-full px-3 py-1 font-label text-xs font-semibold ${cls}`}>
      {status}
    </span>
  );
}
