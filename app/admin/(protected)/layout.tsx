import Image from "next/image";
import AdminNav from "@/components/admin/AdminNav";
import { requireAdmin } from "@/lib/admin-auth";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdmin();

  return (
    <div className="min-h-dvh bg-surface">
      <header className="sticky top-0 z-40 border-b border-outline-variant/30 bg-surface-container-low/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt=""
              aria-hidden="true"
              width={32}
              height={32}
              priority
              className="drop-shadow-[0_2px_6px_rgba(0,109,61,0.2)]"
            />
            <span className="font-headline text-lg font-extrabold tracking-tighter text-primary">
              Centient Admin
            </span>
          </div>
          <div className="flex items-center gap-2">
            <AdminNav role={session.role} />
            <form action="/api/admin/logout" method="post">
              <button
                type="submit"
                className="rounded-full px-4 py-2 font-label text-sm font-semibold text-outline transition-colors hover:bg-surface-container-low"
              >
                Logout
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6 md:p-10">{children}</main>
    </div>
  );
}