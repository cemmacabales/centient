import TaskTable from "@/components/admin/TaskTable";
import ExportButton from "@/components/admin/ExportButton";
import { getTaskTableItems } from "@/lib/admin-data";
import { requireRoleForPage } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export default async function AdminTasksPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const items = await getTaskTableItems();
  const categories = Array.from(
    new Set(items.map((i) => i.category).filter((c): c is string => !!c)),
  ).sort();

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Training data
        </div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
            Tasks
          </h1>
          <ExportButton />
        </div>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          All {items.length} seeded task pairs. Click any row to inspect the responses and recent
          submissions.
        </p>
      </header>

      <TaskTable items={items} categories={categories} />
    </div>
  );
}
