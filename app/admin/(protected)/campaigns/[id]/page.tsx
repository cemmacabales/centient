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

  const campaign = await prisma.campaign.findFirst({
    where: { id, adminUserId: session.sub },
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
      rewardWei: true,
      createdAt: true,
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

  return (
    <CampaignDetail
      campaignId={id}
      campaignName={campaign.name}
      defaultResponseTarget={campaign.defaultResponseTarget}
      rewardWei={campaign.rewardWei.toString()}
    />
  );
}
