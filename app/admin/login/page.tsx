import Image from "next/image";
import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function AdminLoginPage(props: LoginPageProps) {
  const session = await getAdminSession();
  if (session.adminId) redirect("/admin");
  const { error } = await props.searchParams;
  const showError = error === "invalid";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-6">
      <div className="w-full max-w-sm rounded-3xl bg-surface-container-lowest p-8 shadow-[0_8px_32px_rgba(25,28,30,0.08)]">
        <div className="flex flex-col items-center text-center">
          <Image
            src="/logo.png"
            alt=""
            aria-hidden="true"
            width={72}
            height={72}
            priority
            className="drop-shadow-[0_4px_12px_rgba(0,109,61,0.25)]"
          />
          <div className="mt-4 font-headline text-xl font-extrabold tracking-tighter text-primary">
            Centient Admin
          </div>
          <p className="mt-2 font-body text-sm text-on-surface-variant">
            Sign in with your operator credentials.
          </p>
        </div>
        {showError ? (
          <div
            role="alert"
            className="mt-6 rounded-lg bg-error-container px-4 py-3 font-label text-sm font-semibold text-on-error-container"
          >
            Invalid email or password.
          </div>
        ) : null}
        <form action="/api/admin/login" method="post" className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block font-headline text-sm font-bold text-on-surface"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block font-headline text-sm font-bold text-on-surface"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
          </div>
          <button
            type="submit"
            className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-base font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-all duration-200 hover:shadow-[0_12px_32px_rgba(0,109,61,0.3)] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Sign in
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              arrow_forward
            </span>
          </button>
        </form>
      </div>
    </div>
  );
}
