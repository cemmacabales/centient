import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import CustomerTable from "@/components/admin/CustomerTable";
import AddCustomerButton from "@/components/admin/AddCustomerButton";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const customers = await prisma.adminUser.findMany({
    where: { role: "CUSTOMER" },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, companyName: true, createdAt: true },
  }).then((rows) =>
    rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
  );

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
