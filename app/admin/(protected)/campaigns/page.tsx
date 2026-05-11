import { requireAdmin } from "@/lib/admin-auth";
import ExportButton from "@/components/admin/ExportButton";

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
          {session.companyName ? `Welcome, ${session.companyName}.` : "Welcome."}
        </p>
      </header>

      <section className="rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-8">
        <h2 className="font-headline text-xl font-bold text-on-surface mb-4">Export Dataset</h2>
        <ExportButton />
      </section>
    </div>
  );
}
