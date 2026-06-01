import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import CampaignDetail from "@/components/admin/CampaignDetail";

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
      name: true,
      defaultResponseTarget: true,
      pausedAt: true,
      createdAt: true,
      adminUser: { select: { email: true, companyName: true } },
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

  const isOwner = campaign.adminUser.email === session.email;
  const isReadOnly = session.role === "SUPER_ADMIN" && !isOwner;

  return (
    <CampaignDetail
      campaignId={id}
      campaignName={campaign.name}
      defaultResponseTarget={campaign.defaultResponseTarget}
      pausedAt={campaign.pausedAt?.toISOString() ?? null}
      ownerEmail={campaign.adminUser.companyName ?? campaign.adminUser.email}
      isReadOnly={isReadOnly}
    />
  );
}
