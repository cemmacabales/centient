import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export default async function AdminDashboardRedirect() {
  const session = await requireAdmin();

  if (session.role === ("SUPER_ADMIN" as string)) {
    redirect("/admin/tasks");
  } else {
    redirect("/admin/campaigns");
  }
}
