interface GoldPassRateStats {
  totalAttempted: number;
  totalCorrect: number;
  ratePct: number | null;
}

interface GoldAccuracyBucket {
  accuracyRange: string;
  count: number;
}

export default function GoldPassRateCard({
  stats,
  distribution,
}: {
  stats: GoldPassRateStats;
  distribution: GoldAccuracyBucket[];
}) {
  const totalUsers = distribution.reduce((a, b) => a + b.count, 0);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Overall gold pass rate
        </div>
        <div className="mt-3 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          {stats.ratePct !== null ? `${stats.ratePct}%` : "—"}
        </div>
        <div className="mt-2 font-body text-sm text-on-surface-variant">
          {stats.totalCorrect} of {stats.totalAttempted} attempts passed
        </div>
      </section>

      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Per-user gold accuracy
        </div>
        {totalUsers === 0 ? (
          <div className="mt-3 font-body text-sm text-on-surface-variant">
            No users yet.
          </div>
        ) : (
          <div className="mt-3 space-y-1.5">
            {distribution.map((b) => {
              const pct = totalUsers > 0 ? Math.round((b.count / totalUsers) * 100) : 0;
              return (
                <div key={b.accuracyRange} className="flex items-center gap-3">
                  <span className="w-16 font-body text-xs font-medium text-on-surface-variant">
                    {b.accuracyRange}
                  </span>
                  <div className="flex-1 overflow-hidden rounded-full bg-surface-container-low">
                    <div
                      className="h-2 rounded-full bg-primary transition-all"
                      style={{ width: `${Math.max(pct, 2)}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-body text-xs font-semibold text-on-surface">
                    {b.count}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
