import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import CampaignDetail from "@/components/admin/CampaignDetail";
import { getBalanceSummary } from "@/lib/campaign-balance";

export const dynamic = "force-dynamic";

export default async function AdminCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireRoleForPage("CUSTOMER");

  const { id } = await params;

  // SUPER_ADMIN can view any campaign; CUSTOMER only their own.
  const where = session.role === "SUPER_ADMIN" ? { id } : { id, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: {
      id: true,
      adminUserId: true,
      name: true,
      defaultResponseTarget: true,
      rewardStroops: true,
      pausedAt: true,
      createdAt: true,
      adminUser: { select: { companyName: true, email: true } },
      _count: { select: { tasks: true } },
    },
  });

  if (!campaign) {
    return (
      <div className="space-y-6">
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Campaign not found
        </h1>
      </div>
    );
  }

  const balanceSummary = await getBalanceSummary(id, campaign.rewardStroops);

  const recentLedger = await prisma.balanceLedger.findMany({
    where: { campaignId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      type: true,
      amountStroops: true,
      note: true,
      submissionId: true,
      createdAt: true,
    },
  });

  // Compare the stable adminUserId from the JWT (`session.sub`) rather than the
  // mutable email — emails can change post-issue, and case/whitespace handling
  // diverges between the JWT and the DB. campaign.adminUserId is the source of truth.
  const isOwner = campaign.adminUserId === session.sub;
  const isReadOnly = session.role === "SUPER_ADMIN" && !isOwner;
  // Operator (SUPER_ADMIN) can manage any campaign; the customer can manage their own.
  const canManage = isOwner || session.role === "SUPER_ADMIN";

  return (
    <CampaignDetail
      campaignId={id}
      campaignName={campaign.name}
      defaultResponseTarget={campaign.defaultResponseTarget}
      rewardStroops={campaign.rewardStroops.toString()}
      pausedAt={campaign.pausedAt?.toISOString() ?? null}
      ownerEmail={campaign.adminUser.companyName ?? campaign.adminUser.email}
      isReadOnly={isReadOnly}
      canManage={canManage}
      balanceStroops={balanceSummary.balanceStroops.toString()}
      estimatedSubmissionsRemaining={balanceSummary.estimatedSubmissionsRemaining}
      recentLedger={recentLedger.map((e) => ({
        type: e.type,
        amountStroops: e.amountStroops.toString(),
        note: e.note,
        submissionId: e.submissionId,
        createdAt: e.createdAt.toISOString(),
      }))}
      isSuperAdmin={session.role === "SUPER_ADMIN"}
    />
  );
}
