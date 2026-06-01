import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import CampaignList from "@/components/admin/CampaignList";
import DeleteCustomerButton from "@/components/admin/DeleteCustomerButton";

export const dynamic = "force-dynamic";

interface CampaignWithProgress {
  id: string;
  name: string;
  defaultResponseTarget: number;
  taskCount: number;
  totalResponses: number;
  totalTarget: number;
  completionPct: number;
  createdAt: string;
  pausedAt: string | null;
  ownerEmail: string | null;
}

interface AggregateStats {
  totalCampaigns: number;
  totalTasks: number;
  totalResponses: number;
  overallCompletionPct: number;
}

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRoleForPage("SUPER_ADMIN");

  const { id } = await params;

  const customer = await prisma.adminUser.findFirst({
    where: { id, role: "CUSTOMER" },
    select: {
      id: true,
      email: true,
      companyName: true,
      createdAt: true,
      isVerified: true,
      verifiedAt: true,
    },
  });

  if (!customer) {
    notFound();
  }

  const campaigns = await prisma.campaign.findMany({
    where: { adminUserId: customer.id },
    orderBy: { createdAt: "asc" },
    include: {
      tasks: {
        select: {
          responseTarget: true,
          _count: { select: { submissions: { where: { payoutStatus: "sent", isGoldCheck: false } } } },
        },
      },
    },
  });

  const campaignsWithProgress: CampaignWithProgress[] = campaigns.map((c) => {
    const taskCount = c.tasks.length;
    const totalTarget = c.tasks.reduce(
      (sum, t) => sum + (t.responseTarget ?? c.defaultResponseTarget),
      0,
    );
    const totalResponses = c.tasks.reduce((sum, t) => sum + t._count.submissions, 0);
    const completionPct =
      totalTarget > 0 ? Math.min(100, Math.round((totalResponses / totalTarget) * 100)) : 0;
    return {
      id: c.id,
      name: c.name,
      defaultResponseTarget: c.defaultResponseTarget,
      taskCount,
      totalResponses,
      totalTarget,
      completionPct,
      createdAt: c.createdAt.toISOString(),
      pausedAt: c.pausedAt?.toISOString() ?? null,
      ownerEmail: customer.companyName ?? customer.email,
    };
  });

  const aggregate: AggregateStats = {
    totalCampaigns: campaigns.length,
    totalTasks: campaignsWithProgress.reduce((sum, c) => sum + c.taskCount, 0),
    totalResponses: campaignsWithProgress.reduce((sum, c) => sum + c.totalResponses, 0),
    overallCompletionPct: 0,
  };

  const grandTotalTarget = campaignsWithProgress.reduce((sum, c) => sum + c.totalTarget, 0);
  if (grandTotalTarget > 0) {
    aggregate.overallCompletionPct = Math.min(
      100,
      Math.round((aggregate.totalResponses / grandTotalTarget) * 100),
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          <Link href="/admin/customers" className="hover:underline">
            ← Customers
          </Link>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
              {customer.companyName ?? customer.email}
            </h1>
            <p className="mt-1 font-body text-sm text-on-surface-variant">
              <span className="font-mono">{customer.email}</span>
              <span className="mx-2 text-outline">·</span>
              Customer since {new Date(customer.createdAt).toLocaleDateString("en-US")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {customer.isVerified ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 font-label text-xs font-semibold text-green-700">
                <span className="material-symbols-outlined text-[14px]">check_circle</span>
                Verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-3 py-1 font-label text-xs font-semibold text-yellow-700">
                <span className="material-symbols-outlined text-[14px]">schedule</span>
                Pending verification
              </span>
            )}
            <DeleteCustomerButton customerId={customer.id} companyName={customer.companyName} />
          </div>
        </div>
      </header>

      <CampaignList
        initialCampaigns={campaignsWithProgress}
        aggregate={aggregate}
        hideNewButton
      />
    </div>
  );
}
