"use client";

import Image from "next/image";
import SubmitButton from "./SubmitButton";
import Faq from "./Faq";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";

interface LandingProps {
  totalEarned: string;
  submissionCount: number;
  onStart: () => void;
}

export default function Landing({ totalEarned, submissionCount, onStart }: LandingProps) {
  const isNew = submissionCount === 0;
  const subline = isNew
    ? "Welcome — let's get started."
    : `${submissionCount} submission${submissionCount === 1 ? "" : "s"}`;

  return (
    <div className="relative min-h-screen bg-surface px-6 pb-12 pt-10">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
        <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
      </div>

      <div className="relative z-10 mx-auto flex max-w-lg flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/logo.png"
            alt=""
            width={96}
            height={96}
            priority
            className="select-none drop-shadow-[0_8px_24px_rgba(0,109,61,0.15)]"
          />
          <span className="text-3xl font-headline font-extrabold tracking-tighter text-primary">
            Centient
          </span>
          <p className="font-body text-sm text-on-surface-variant">
            Train AI, cent by cent.
          </p>
        </div>

        <div className="w-full rounded-3xl bg-surface-container-lowest p-6 shadow-[0_8px_32px_rgba(25,28,30,0.06)]">
          <div className="flex flex-col items-center">
            <span className="mb-2 font-label text-xs font-bold uppercase tracking-widest text-outline">
              Your Balance
            </span>
            <div className="flex items-baseline gap-1">
              <span className="font-headline text-4xl font-extrabold tracking-tighter text-on-surface">
                {totalEarned}
              </span>
              <span className="font-headline text-xl font-bold text-secondary">
                {REWARD_TOKEN_SYMBOL}
              </span>
            </div>
            <span className="mt-1 font-body text-xs text-on-surface-variant">
              {subline}
            </span>
          </div>
        </div>

        <Faq />

        <div className="w-full pt-2">
          <SubmitButton label="Start Earning" onClick={onStart} />
        </div>

        <p className="pt-4 text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
          centient.work
        </p>
      </div>
    </div>
  );
}
