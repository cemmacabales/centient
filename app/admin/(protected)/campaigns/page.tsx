import { requireRoleForPage } from "@/lib/admin-auth";
import CampaignList from "@/components/admin/CampaignList";

export const dynamic = "force-dynamic";

export default async function AdminCampaignsPage() {
  await requireRoleForPage("CUSTOMER");

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/admin/campaigns`,
    { cache: "no-store" }
  );
  const campaigns = res.ok ? await res.json() : [];

  return <CampaignList initialCampaigns={campaigns} />;
}