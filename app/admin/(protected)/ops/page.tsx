import { requireRoleForPage } from "@/lib/admin-auth";
import { getOpsDashboardData } from "@/lib/admin-data";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import SubmissionVolumeChart from "@/components/admin/SubmissionVolumeChart";
import PayoutVolumeChart from "@/components/admin/PayoutVolumeChart";
import GoldPassRateCard from "@/components/admin/GoldPassRateCard";
import CategoryDistributionChart from "@/components/admin/CategoryDistributionChart";

export const dynamic = "force-dynamic";

export default async function AdminOpsPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const data = await getOpsDashboardData();

  return (
    <div className="space-y-8">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Historical views
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Ops
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          Time-series aggregation over the last 24 hours. Complements the live snapshot at Status.
        </p>
      </header>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          24h submission volume
        </h2>
        <div className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
          {data.submissionVolume24h.length === 0 ? (
            <div className="py-8 text-center font-body text-sm text-on-surface-variant">
              No submissions in the last 24 hours.
            </div>
          ) : (
            <SubmissionVolumeChart data={data.submissionVolume24h} />
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          24h payout volume ({REWARD_TOKEN_SYMBOL})
        </h2>
        <div className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
          {data.payoutVolume24h.length === 0 ? (
            <div className="py-8 text-center font-body text-sm text-on-surface-variant">
              No payouts in the last 24 hours.
            </div>
          ) : (
            <PayoutVolumeChart
              data={data.payoutVolume24h}
              symbol={REWARD_TOKEN_SYMBOL}
            />
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          Gold-pass rate
        </h2>
        <GoldPassRateCard stats={data.goldPassRate} distribution={data.goldAccuracyDistribution} />
      </section>

      <section>
        <h2 className="mb-3 font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
          Per-category submissions
        </h2>
        <div className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
          {data.categoryDistribution.length === 0 ? (
            <div className="py-8 text-center font-body text-sm text-on-surface-variant">
              No submission data yet.
            </div>
          ) : (
            <CategoryDistributionChart data={data.categoryDistribution} />
          )}
        </div>
      </section>
    </div>
  );
}
