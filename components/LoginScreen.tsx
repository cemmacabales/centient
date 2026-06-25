"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { isMiniPay } from "@/lib/minipay";
import { isMetaMask } from "@/lib/metamask";
import { isSimulationMode } from "@/lib/simulation";
import Faq from "./Faq";
import WalletLoginButton, { type WalletLoginType } from "./WalletLoginButton";

interface LoginScreenProps {
  onConnect: (type: WalletLoginType) => void;
  /** Open the email account flow. P5a: this is the primary entry. */
  onEmailAuth: (mode: "login" | "register") => void;
  error: string | null;
}

/**
 * P5a — account-first entry. Email account creation/sign-in is the primary path;
 * wallet login is demoted to a clearly-labelled secondary option so existing
 * wallet users can still get in. A short explainer clarifies how the account and a
 * wallet relate (one account holds the balance; a wallet is only needed to withdraw).
 */
export default function LoginScreen({ onConnect, onEmailAuth, error }: LoginScreenProps) {
  const [ready, setReady] = useState(false);
  const [miniPay, setMiniPay] = useState(false);
  const [metaMask, setMetaMask] = useState(false);
  const [sim, setSim] = useState(false);

  useEffect(() => {
    setMiniPay(isMiniPay());
    setMetaMask(isMetaMask());
    setSim(isSimulationMode());
    setReady(true);
  }, []);

  const showMiniPay = ready && miniPay;
  const showMetaMaskPrimary = ready && !miniPay && metaMask;
  const showOpenMiniPay = ready && !miniPay && !metaMask;
  const showMetaMaskSecondary = ready && miniPay && metaMask;
  const showSimButton = ready && sim;

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

          {/* SECONDARY (P5a): wallet login, still supported for existing users */}
          <div className="flex w-full max-w-xs flex-col items-center gap-3">
            <div className="my-1 flex w-full items-center gap-3">
              <span className="h-px flex-1 bg-outline-variant/60" />
              <span className="font-label text-xs font-semibold uppercase tracking-widest text-outline">
                Have a wallet?
              </span>
              <span className="h-px flex-1 bg-outline-variant/60" />
            </div>

            {!ready && (
              <div className="h-14 w-full max-w-xs animate-pulse rounded-full bg-surface-container-high" />
            )}

            {showMiniPay && (
              <WalletLoginButton type="minipay" variant="secondary" onClick={() => onConnect("minipay")} />
            )}

            {showMetaMaskPrimary && (
              <WalletLoginButton type="metamask" variant="secondary" onClick={() => onConnect("metamask")} />
            )}

            {showOpenMiniPay && (
              <a
                href="https://minipay.to"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-full border border-outline-variant bg-surface-container-lowest font-label text-base font-bold text-on-surface transition duration-200 hover:bg-surface-container-low active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Open in MiniPay
                <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                  arrow_forward
                </span>
              </a>
            )}

            {showMetaMaskSecondary && (
              <WalletLoginButton type="metamask" variant="secondary" onClick={() => onConnect("metamask")} />
            )}

            {showSimButton && (
              <button
                type="button"
                onClick={() => onConnect("sim")}
                className="flex h-12 w-full max-w-xs items-center justify-center gap-2 rounded-full border border-dashed border-primary bg-surface-container-high font-label text-sm font-bold text-primary transition duration-200 hover:bg-surface-container-low active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  science
                </span>
                Simulate MiniPay login
              </button>
            )}

            <p className="mt-1 max-w-xs text-center text-xs text-on-surface-variant">
              Wallet login is still fully supported — existing users can sign in with their
              wallet as before.
            </p>
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
