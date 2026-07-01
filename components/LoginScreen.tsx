"use client";

import Image from "next/image";
import Faq from "./Faq";

interface LoginScreenProps {
  /** Open the email account flow. Email/password is the only entry (ST-4c). */
  onEmailAuth: (mode: "login" | "register") => void;
  error: string | null;
}

/**
 * Account-first entry. Email account creation/sign-in is the only login path —
 * EVM browser-wallet signature-login was ripped out in ST-4c. A Stellar wallet is
 * linked only later, at withdrawal, to prove the payout address.
 */
export default function LoginScreen({ onEmailAuth, error }: LoginScreenProps) {
  return (
    <div className="relative min-h-screen bg-surface">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
        <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-2xl px-5 pb-20 pt-16">
        <section className="flex flex-col items-center gap-6 pb-10 text-center">
          <Image
            src="/logo.png"
            alt="Centient logo"
            width={96}
            height={96}
            priority
            className="select-none drop-shadow-[0_8px_24px_rgba(0,109,61,0.15)]"
          />

          <div>
            <h1 className="text-[2.25rem] font-headline font-extrabold leading-[1.1] tracking-tight text-on-surface">
              Earn with{" "}
              <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                Centient
              </span>
            </h1>
            <p className="mt-2 font-body text-base text-on-surface-variant">
              Train AI, cent by cent. Create an account to start — no wallet needed.
            </p>
          </div>

          {error && <p className="max-w-xs text-sm text-error">{error}</p>}

          {/* PRIMARY (P5a): account-first */}
          <div className="flex w-full max-w-xs flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => onEmailAuth("register")}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                mail
              </span>
              Create account
            </button>
            <p className="font-body text-sm text-on-surface-variant">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => onEmailAuth("login")}
                className="font-semibold text-primary underline-offset-2 hover:underline"
              >
                Sign in
              </button>
            </p>
          </div>

          {/* How it works — account ↔ wallet relationship + earnings flow */}
          <div className="w-full max-w-xs rounded-2xl bg-surface-container-low p-4 text-left">
            <div className="flex items-start gap-3">
              <span
                className="material-symbols-outlined mt-0.5 text-[22px] text-primary"
                aria-hidden="true"
              >
                savings
              </span>
              <p className="font-body text-sm text-on-surface-variant">
                Your <span className="font-semibold text-on-surface">account</span> holds the
                balance you earn from labelling. Approved answers add to it automatically —
                connect a wallet only when you&apos;re ready to withdraw. One account, one
                balance, withdraw anytime.
              </p>
            </div>
          </div>

        </section>

        <section className="mb-10">
          <div className="mb-1 text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            FAQ
          </div>
          <Faq />
        </section>
      </div>
    </div>
  );
}
