"use client";

import Image from "next/image";
import { useState } from "react";

type Mode = "login" | "register";

interface AccountAuthScreenProps {
  /** Return to the wallet/entry screen. */
  onBack: () => void;
  /** Called after a successful email/password login (session cookie set). */
  onLoggedIn: () => void;
  /** P5a: which mode to open in — "register" when entering account-first. */
  initialMode?: Mode;
}

function authErrorMessage(code: string | undefined, status: number, mode: Mode): string {
  switch (code) {
    case "invalid_credentials":
      return "Email or password is incorrect.";
    case "email_not_verified":
      return "Please verify your email first — check your inbox for the link.";
    case "rate_limited":
      return "Too many attempts. Please wait a moment and try again.";
    case "invalid_email":
      return "Enter a valid email address.";
    case "weak_password":
      return "Password must be at least 8 characters and include a number and a symbol.";
    case "missing_fields":
      return "Please enter both your email and password.";
    case "invalid_body":
      return "Something went wrong reading your details. Please try again.";
  }
  return mode === "login"
    ? `Sign in failed (${code ?? status}). Please try again.`
    : `Sign up failed (${code ?? status}). Please try again.`;
}

export default function AccountAuthScreen({ onBack, onLoggedIn, initialMode = "login" }: AccountAuthScreenProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

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
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      let res: Response;
      try {
        res = await fetch(endpoint, {
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
        setError(authErrorMessage(data?.error, res.status, mode));
        return;
      }

      if (mode === "register") {
        // The register endpoint returns the same generic response whether the
        // email is new or already taken, so we always show "check your inbox".
        setRegistered(true);
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

          {registered ? (
            <div className="flex w-full flex-col items-center gap-4">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-secondary-container">
                <span
                  className="material-symbols-outlined text-[40px] text-on-secondary-container"
                  aria-hidden="true"
                >
                  mark_email_unread
                </span>
              </div>
              <h1 className="text-2xl font-headline font-extrabold text-on-surface">
                Check your inbox
              </h1>
              <p className="max-w-xs font-body text-sm text-on-surface-variant">
                If that email is new, we sent a verification link to{" "}
                <span className="font-semibold text-on-surface">{email.trim()}</span>. Open it to
                activate your account, then sign in.
              </p>
              <button
                type="button"
                onClick={() => {
                  setRegistered(false);
                  switchMode("login");
                  setPassword("");
                }}
                className="mt-2 flex h-12 w-full items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-base font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97]"
              >
                Go to sign in
              </button>
            </div>
          ) : (
            <>
              <div>
                <h1 className="text-[2rem] font-headline font-extrabold leading-[1.1] tracking-tight text-on-surface">
                  {mode === "login" ? "Welcome back" : "Create your account"}
                </h1>
                <p className="mt-2 font-body text-base text-on-surface-variant">
                  {mode === "login"
                    ? "Sign in with your email to keep earning."
                    : "Sign up with an email — no wallet needed to start."}
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
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "login" ? "Your password" : "At least 8 characters"}
                    className="h-12 rounded-2xl border border-outline-variant bg-surface-container-lowest px-4 font-body text-base text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                    required
                  />
                  {mode === "register" && (
                    <span className="mt-1 font-body text-xs text-on-surface-variant">
                      Use 8+ characters with at least one number and one symbol.
                    </span>
                  )}
                </label>

                {error && <p className="font-body text-sm text-error">{error}</p>}

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-1 flex h-14 w-full items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] disabled:opacity-60"
                >
                  {submitting
                    ? mode === "login"
                      ? "Signing in…"
                      : "Creating account…"
                    : mode === "login"
                    ? "Sign in"
                    : "Create account"}
                </button>
              </form>

              <p className="font-body text-sm text-on-surface-variant">
                {mode === "login" ? "New to Centient? " : "Already have an account? "}
                <button
                  type="button"
                  onClick={() => switchMode(mode === "login" ? "register" : "login")}
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                >
                  {mode === "login" ? "Create an account" : "Sign in"}
                </button>
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
