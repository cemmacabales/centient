"use client";

import { useState } from "react";
import type { ProgressView } from "@/lib/gamification/types";
import EventCodeCard from "./EventCodeCard";
import InviteCard from "./InviteCard";
import OnHoldCard from "./OnHoldCard";
import StampGrid from "./StampGrid";
import TierCard from "./TierCard";
import WeeklyBoard from "./WeeklyBoard";

export type ProgressTab = "stamps" | "week";

interface ProgressScreenProps {
  progress: ProgressView | null | undefined;
  onBack: () => void;
  initialTab?: ProgressTab;
  /** #203: a code from a booth link, waiting on the Event code card. */
  pendingCode?: string | null;
  /** After a code is added: reload progress so its stamp and XP show. */
  onRedeemed?: () => void;
}

function Tabs({ tab, onTab, earned, total }: { tab: ProgressTab; onTab: (t: ProgressTab) => void; earned: number; total: number }) {
  const item = (id: ProgressTab, label: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      id={`progress-tab-${id}`}
      aria-selected={tab === id}
      aria-controls="progress-panel"
      onClick={() => onTab(id)}
      className={`flex h-11 items-center justify-center gap-1.5 rounded-full font-label text-sm transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-primary ${
        tab === id
          ? "bg-surface-container-lowest font-bold text-on-surface shadow-[0_4px_12px_rgba(25,28,30,0.04)]"
          : "font-semibold text-on-surface-variant"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Progress views" className="grid grid-cols-2 gap-1 rounded-full bg-surface-container-high p-1">
      {item(
        "stamps",
        <>
          Stamps{" "}
          <span className="font-bold tabular-nums text-tertiary">
            {earned} of {total}
          </span>
        </>,
      )}
      {item("week", "This week")}
    </div>
  );
}

/**
 * #202 (board 07): the tier in full and the stamps. #203 (boards 07, 08): a
 * This week tab for the quests and the weekly board, and the Event code and
 * invite cards under the stamps.
 */
export default function ProgressScreen({ progress, onBack, initialTab = "stamps", pendingCode = null, onRedeemed }: ProgressScreenProps) {
  const [tab, setTab] = useState<ProgressTab>(initialTab);
  const earned = progress?.stamps.filter((s) => s.awardedAt).length ?? 0;
  const total = progress?.stamps.length ?? 0;

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-lg flex-col gap-3.5 px-5 pb-8 pt-3">
        <header className="flex h-12 items-center gap-1">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to home"
            className="-ml-2.5 flex h-11 w-11 items-center justify-center rounded-full text-on-surface focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              arrow_back
            </span>
          </button>
          <h1 className="m-0 font-headline text-xl font-bold text-on-surface">Progress</h1>
        </header>

        {progress ? (
          tab === "stamps" ? (
            <>
              <TierCard
                tier={progress.tier}
                xpTotal={progress.xpTotal}
                detail={{ streakDays: progress.streak.days, restDays: progress.streak.restDays }}
              />
              {progress.tier.onHold && <OnHoldCard tier={progress.tier} />}
              <div className="pt-3">
                <Tabs tab={tab} onTab={setTab} earned={earned} total={total} />
              </div>
              <div id="progress-panel" role="tabpanel" aria-labelledby="progress-tab-stamps" className="flex flex-col gap-3.5">
                <StampGrid stamps={progress.stamps} bestRank={progress.board?.bestRank ?? null} />
                <EventCodeCard initialCode={pendingCode} onRedeemed={() => onRedeemed?.()} />
                {progress.invite && <InviteCard invite={progress.invite} />}
              </div>
            </>
          ) : (
            <>
              <Tabs tab={tab} onTab={setTab} earned={earned} total={total} />
              <div id="progress-panel" role="tabpanel" aria-labelledby="progress-tab-week" className="flex flex-col gap-3.5">
                <WeeklyBoard quests={progress.quests ?? []} />
              </div>
            </>
          )
        ) : progress === null ? (
          <p className="font-body text-sm text-on-surface-variant">Your progress couldn&apos;t load. Try again in a moment.</p>
        ) : (
          <div aria-hidden="true" className="flex flex-col gap-3.5">
            <div className="h-[330px] animate-pulse rounded-3xl bg-surface-container-high motion-reduce:animate-none" />
            <div className="h-[360px] animate-pulse rounded-3xl bg-surface-container-high motion-reduce:animate-none" />
          </div>
        )}
      </div>
    </div>
  );
}
