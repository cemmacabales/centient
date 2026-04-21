interface StatCardProps {
  label: string;
  value: string;
  subline?: string;
}

export default function StatCard({ label, value, subline }: StatCardProps) {
  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
      <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
        {label}
      </div>
      <div className="mt-3 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
        {value}
      </div>
      {subline ? (
        <div className="mt-2 font-body text-sm text-on-surface-variant">{subline}</div>
      ) : null}
    </section>
  );
}
