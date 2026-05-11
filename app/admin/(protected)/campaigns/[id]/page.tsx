import { requireRoleForPage } from "@/lib/admin-auth";
import CampaignDetail from "@/components/admin/CampaignDetail";

export const dynamic = "force-dynamic";

export default async function AdminCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRoleForPage("CUSTOMER");

  const { id } = await params;

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/admin/campaigns/${id}`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    return (
      <div className="space-y-6">
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Campaign not found
        </h1>
      </div>
    );
  }

  const campaign = await res.json();

  return <CampaignDetail campaignId={id} campaignName={campaign.name} />;
}