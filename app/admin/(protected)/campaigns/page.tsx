import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import CampaignList from "@/components/admin/CampaignList";

export const dynamic = "force-dynamic";

export default async function AdminCampaignsPage() {
  const session = await requireRoleForPage("CUSTOMER");

  const campaigns = await prisma.campaign.findMany({
    where: { adminUserId: session.sub },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      defaultResponseTarget: true,
      createdAt: true,
      _count: { select: { tasks: true } },
    },
  }).then((rows) =>
    rows.map((c) => ({
      id: c.id,
      name: c.name,
      defaultResponseTarget: c.defaultResponseTarget,
      taskCount: c._count.tasks,
      createdAt: c.createdAt.toISOString(),
    }))
  );

  return <CampaignList initialCampaigns={campaigns} />;
}
