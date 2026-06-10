import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import DisputeTable from "@/components/admin/DisputeTable";

export const dynamic = "force-dynamic";

export default async function AdminDisputesPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const disputes = await prisma.dispute.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const serialized = disputes.map((d) => ({
    id: d.id,
    walletAddress: d.walletAddress,
    reason: d.reason,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
  }));

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Trust &amp; Safety
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Disputes
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          Open ban appeals submitted by labelers. Resolve to clear or dismiss, optionally unbanning the wallet.
        </p>
      </header>

      <DisputeTable rows={serialized} />
    </div>
  );
}
