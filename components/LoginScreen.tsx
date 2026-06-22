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
  onEmailLogin: () => void;
  error: string | null;
}

export default function LoginScreen({ onConnect, onEmailLogin, error }: LoginScreenProps) {
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
        <section className="flex flex-col items-center gap-6 pb-12 text-center">
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
              Login to{" "}
              <span className="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
                Centient
              </span>
            </h1>
            <p className="mt-2 font-body text-base text-on-surface-variant">
              Train AI, cent by cent. Connect your wallet to start.
            </p>
          </div>

          {error && <p className="max-w-xs text-sm text-error">{error}</p>}

          <div className="flex w-full max-w-xs flex-col items-center gap-3">
            {showMiniPay && (
              <WalletLoginButton type="minipay" onClick={() => onConnect("minipay")} />
            )}

            {showMetaMaskPrimary && (
              <WalletLoginButton type="metamask" onClick={() => onConnect("metamask")} />
            )}

            {showOpenMiniPay && (
              <a
                href="https://minipay.to"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Open in MiniPay
                <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                  arrow_forward
                </span>
              </a>
            )}

            {showMetaMaskSecondary && (
              <WalletLoginButton type="metamask" onClick={() => onConnect("metamask")} />
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

            {ready && !miniPay && !metaMask && (
              <p className="mt-1 max-w-xs text-center text-xs text-on-surface-variant">
                MetaMask is not installed. Open Centient in MiniPay on Android for the full experience.
              </p>
            )}

            {!ready && (
              <div className="h-14 w-full max-w-xs animate-pulse rounded-full bg-surface-container-high" />
            )}

            <div className="my-1 flex w-full items-center gap-3">
              <span className="h-px flex-1 bg-outline-variant/60" />
              <span className="font-label text-xs font-semibold uppercase tracking-widest text-outline">
                or
              </span>
              <span className="h-px flex-1 bg-outline-variant/60" />
            </div>

            <button
              type="button"
              onClick={onEmailLogin}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-full border border-outline-variant bg-surface-container-lowest font-label text-base font-bold text-on-surface transition duration-200 hover:bg-surface-container-low active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                mail
              </span>
              Continue with email
            </button>
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
