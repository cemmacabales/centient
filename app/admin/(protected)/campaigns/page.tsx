import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import CampaignList from "@/components/admin/CampaignList";

export const dynamic = "force-dynamic";

interface CampaignWithProgress {
  id: string;
  name: string;
  defaultResponseTarget: number;
  rewardWei: string;
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

export default async function AdminCampaignsPage() {
  const session = await requireRoleForPage("CUSTOMER");

  // SUPER_ADMIN sees all campaigns; CUSTOMER sees only their own.
  const where = session.role === "SUPER_ADMIN" ? {} : { adminUserId: session.sub };

  const campaigns = await prisma.campaign.findMany({
    where,
    orderBy: { createdAt: "asc" },
    include: {
      tasks: {
        select: {
          responseTarget: true,
          _count: { select: { submissions: { where: { payoutStatus: "sent", isGoldCheck: false } } } },
        },
      },
      adminUser: { select: { email: true, companyName: true } },
    },
  });

  const campaignsWithProgress: CampaignWithProgress[] = campaigns.map((c) => {
    const taskCount = c.tasks.length;
    const totalTarget = c.tasks.reduce((sum, t) => sum + (t.responseTarget ?? c.defaultResponseTarget), 0);
    const totalResponses = c.tasks.reduce((sum, t) => sum + t._count.submissions, 0);
    const completionPct = totalTarget > 0 ? Math.min(100, Math.round((totalResponses / totalTarget) * 100)) : 0;
    return {
      id: c.id,
      name: c.name,
      defaultResponseTarget: c.defaultResponseTarget,
      taskCount,
      totalResponses,
      totalTarget,
      completionPct,
      rewardWei: c.rewardWei.toString(),
      createdAt: c.createdAt.toISOString(),
      pausedAt: c.pausedAt?.toISOString() ?? null,
      ownerEmail: c.adminUser.companyName ?? c.adminUser.email,
    };
  });

  const aggregate: AggregateStats = {
    totalCampaigns: campaigns.length,
    totalTasks: campaignsWithProgress.reduce((sum, c) => sum + c.taskCount, 0),
    totalResponses: campaignsWithProgress.reduce((sum, c) => sum + c.totalResponses, 0),
    overallCompletionPct: 0,
  };

  const grandTotalTarget = campaignsWithProgress.reduce(
    (sum, c) => sum + c.totalTarget,
    0
  );
  if (grandTotalTarget > 0) {
    aggregate.overallCompletionPct = Math.min(
      100,
      Math.round((aggregate.totalResponses / grandTotalTarget) * 100)
    );
  }

  return (
    <CampaignList
      initialCampaigns={campaignsWithProgress}
      aggregate={aggregate}
      showOwner={session.role === "SUPER_ADMIN"}
    />
  );
}
