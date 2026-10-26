"use client";

import Image from "next/image";
import SubmitButton from "./SubmitButton";
import Faq from "./Faq";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { useLogoReady } from "@/lib/use-logo-ready";
import { GAMIFICATION_ON } from "@/lib/gamification/flag";
import type { ProgressView } from "@/lib/gamification/types";
import TierCard from "./gamification/TierCard";
import OnHoldCard from "./gamification/OnHoldCard";
import WeekCard from "./gamification/WeekCard";

interface InAppLandingProps {
  totalEarned: string;
  submissionCount: number;
  onStart: () => void;
  /** #201: the XP loop, behind NEXT_PUBLIC_GAMIFICATION. Undefined while loading; null when unavailable. */
  progress?: ProgressView | null;
  /** #202: opens Progress and stamps; #203: or straight to This week. */
  onOpenProgress?: (tab?: "stamps" | "week") => void;
}

/** #203 (board 03): where the labeler stands on this week's board. */
function boardStanding(board: ProgressView["board"] | undefined): string {
  if (!board || board.xp === 0) return "Not on it yet";
  if (!board.placed || board.rank === null) return "Not placed yet";
  return `You're #${board.rank}`;
}

function NavRow({
  icon,
  label,
  onClick,
  children,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-2.5 rounded-xl text-left text-on-surface focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-tertiary-fixed">
        <span className="material-symbols-outlined text-[18px] text-tertiary" aria-hidden="true">
          {icon}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate font-label text-[15px] font-semibold">{label}</span>
      <span className="shrink-0 font-body text-[13px] tabular-nums text-on-surface-variant">{children}</span>
      <span className="material-symbols-outlined text-[22px] text-outline" aria-hidden="true">
        chevron_right
      </span>
    </button>
  );
}

export default function InAppLanding({
  totalEarned,
  submissionCount,
  onStart,
  progress,
  onOpenProgress,
}: InAppLandingProps) {
  const isNew = submissionCount === 0;
  const subline = isNew
    ? "Welcome — let's get started."
    : `${submissionCount} submission${submissionCount === 1 ? "" : "s"}`;
  const logo = useLogoReady();

  return (
    <div className="relative min-h-screen bg-surface px-6 pb-12 pt-10">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
        <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
        {GAMIFICATION_ON && (
          <div className="absolute -right-[25%] top-[55%] h-[70vw] w-[70vw] rounded-full bg-tertiary/10 blur-[90px]" />
        )}
      </div>

      <div className="relative z-10 mx-auto flex max-w-lg flex-col items-center gap-6">
        {/* The wordmark and tagline wait for the logo so they appear together. */}
        <div
          className={`flex flex-col items-center gap-3 transition-opacity duration-300 motion-reduce:transition-none ${
            logo.ready ? "opacity-100" : "opacity-0"
          }`}
        >
          <Image
            src="/logo.png"
            alt=""
            width={96}
            height={96}
            priority
            {...logo.imageProps}
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
              Total earned
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

        {GAMIFICATION_ON ? (
          <>
            {progress ? (
              <>
                <TierCard tier={progress.tier} xpTotal={progress.xpTotal} />
                {progress.tier.onHold && <OnHoldCard tier={progress.tier} />}
                <WeekCard progress={progress} />
                {onOpenProgress && (
                  <nav
                    aria-label="Your progress"
                    className="w-full rounded-3xl bg-surface-container-lowest px-4 py-1 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
                  >
                    <NavRow icon="approval" label="Progress and stamps" onClick={() => onOpenProgress("stamps")}>
                      {progress.stamps.filter((s) => s.awardedAt).length} of {progress.stamps.length}
                    </NavRow>
                    <div aria-hidden="true" className="ml-[42px] h-px bg-outline-variant/30" />
                    <NavRow icon="leaderboard" label="This week's board" onClick={() => onOpenProgress("week")}>
                      {boardStanding(progress.board)}
                    </NavRow>
                  </nav>
                )}
              </>
            ) : progress === null ? null : (
              <div aria-hidden="true" className="flex w-full flex-col gap-6">
                <div className="h-[104px] w-full animate-pulse rounded-3xl bg-surface-container-high motion-reduce:animate-none" />
                <div className="h-[168px] w-full animate-pulse rounded-3xl bg-surface-container-high motion-reduce:animate-none" />
              </div>
            )}
            <div className="w-full pt-2">
              <SubmitButton label="Start Earning" onClick={onStart} />
            </div>
            <Faq />
          </>
        ) : (
          <>
            <Faq />

            <div className="w-full pt-2">
              <SubmitButton label="Start Earning" onClick={onStart} />
            </div>
          </>
        )}

        <p className="pt-4 text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
          centient.work
        </p>
      </div>
    </div>
  );
}
