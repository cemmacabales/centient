import { requireRoleForPage } from "@/lib/admin-auth";
import CustomerTable from "@/components/admin/CustomerTable";
import AddCustomerButton from "@/components/admin/AddCustomerButton";

export const dynamic = "force-dynamic";

async function getCustomers() {
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/admin/customers`, {
    cache: "no-store",
    headers: { cookie: "admin_session" },
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function AdminCustomersPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const customers = await getCustomers();

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Customer management
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
            Customers
          </h1>
          <AddCustomerButton />
        </div>
      </header>

      <CustomerTable customers={customers} />
    </div>
  );
}
