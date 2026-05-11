import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export default async function AdminCampaignsPage() {
  const session = await requireAdmin();

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Customer workspace
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Campaigns
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          {session.companyName ? `Welcome, ${session.companyName}.` : "Welcome."} Campaign creation
          and CSV task upload are coming soon.
        </p>
      </header>

      <section className="rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-8">
        <h2 className="font-headline text-xl font-bold text-on-surface">Coming soon</h2>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          You&apos;ll be able to create labeling campaigns, upload CSV task batches, and review
          per-campaign progress here. Track the rollout in{" "}
          <a
            href="https://github.com/webnxt-2030/t2p/issues/94"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-primary underline"
          >
            issue #94
          </a>
          .
        </p>
      </section>
    </div>
  );
}
