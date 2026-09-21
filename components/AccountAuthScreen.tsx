"use client";

import Image from "next/image";
import { useState } from "react";

interface AccountAuthScreenProps {
  /** Return to the wallet/entry screen. */
  onBack: () => void;
  /** Called after a successful email/password login (session cookie set). */
  onLoggedIn: () => void;
}

function authErrorMessage(code: string | undefined, status: number): string {
  switch (code) {
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "email_not_verified":
      return "Please verify your email first — check your inbox for the link.";
    case "rate_limited":
      return "Too many attempts. Please wait a moment and try again.";
    case "invalid_email":
      return "Enter a valid email address.";
    case "missing_fields":
      return "Please enter both your email and password.";
    case "invalid_body":
      return "Something went wrong reading your details. Please try again.";
  }
  return `Sign in failed (${code ?? status}). Please try again.`;
}

/**
 * Email sign-in for an account created before wallet sign-in (#30). There is no
 * sign-up here: registration is retired, and a signed-in email account goes on
 * to connect the Stellar wallet it will be paid to.
 */
export default function AccountAuthScreen({ onBack, onLoggedIn }: AccountAuthScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Please enter both your email and password.");
      return;
    }

    setSubmitting(true);
    try {
      let res: Response;
      try {
        res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail, password }),
        });
      } catch {
        setError("Network error. Please check your connection and try again.");
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(authErrorMessage(data?.error, res.status));
        return;
      }

      onLoggedIn();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative min-h-screen bg-surface">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
        <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen max-w-md flex-col px-5 pb-16 pt-12">
        <button
          type="button"
          onClick={onBack}
          className="mb-8 flex items-center gap-1 self-start font-label text-sm font-semibold text-on-surface-variant transition active:scale-[0.97]"
        >
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            arrow_back
          </span>
          Back
        </button>

        <section className="flex flex-col items-center gap-6 text-center">
          <Image
            src="/logo.png"
            alt="Centient logo"
            width={72}
            height={72}
            priority
            className="select-none drop-shadow-[0_8px_24px_rgba(0,109,61,0.15)]"
          />

          <div>
            <h1 className="text-[2rem] font-headline font-extrabold leading-[1.1] tracking-tight text-on-surface">
              Welcome back
            </h1>
            <p className="mt-2 font-body text-base text-on-surface-variant">
              Sign in to the account you created with email, then connect your Stellar wallet to
              keep earning.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3 text-left">
            <label className="flex flex-col gap-1">
              <span className="font-label text-xs font-bold uppercase tracking-widest text-outline">
                Email
              </span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-12 rounded-2xl border border-outline-variant bg-surface-container-lowest px-4 font-body text-base text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                required
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="font-label text-xs font-bold uppercase tracking-widest text-outline">
                Password
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="h-12 rounded-2xl border border-outline-variant bg-surface-container-lowest px-4 font-body text-base text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                required
              />
            </label>

            {error && <p className="font-body text-sm text-error">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="mt-1 flex h-14 w-full items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] disabled:opacity-60"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
