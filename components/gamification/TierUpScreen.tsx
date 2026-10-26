import Image from "next/image";
import SubmitButton from "../SubmitButton";
import { TIERS } from "@/lib/gamification/tiers";
import type { TierSummary } from "@/lib/gamification/types";
import TierDiscs from "./TierDiscs";
import TierUpReceipt from "./TierUpReceipt";

interface TierUpScreenProps {
  /** The tier just entered, from the answer's progress block. */
  tierUp: number;
  /** What it opened, from /api/me/progress; undefined while that loads. */
  summary: TierSummary | null | undefined;
  onSeeTasks: () => void;
  onHome: () => void;
}

/** #202 (board 06): a new tier, once, after the answer that opened it. */
export default function TierUpScreen({ tierUp, summary, onSeeTasks, onHome }: TierUpScreenProps) {
  const def = TIERS[tierUp];
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <div className="flex flex-col items-center gap-3.5 rounded-b-[40px] bg-tertiary px-6 pb-16 pt-[26px]">
        <Image
          src="/mascot/owl-wave.webp"
          alt=""
          width={116}
          height={116}
          priority
          className="h-[116px] w-[116px] select-none drop-shadow-[0_10px_24px_rgba(7,0,108,0.35)] motion-safe:animate-[tier-owl_600ms_cubic-bezier(0.16,1,0.3,1)_both]"
        />
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 className="m-0 font-headline text-[56px] font-extrabold leading-[56px] tracking-[-0.04em] text-on-tertiary">
            {def.name}
          </h1>
          <p className="m-0 font-body text-base leading-6 text-tertiary-fixed">
            You&apos;ve reached tier {tierUp + 1} of {TIERS.length}.
          </p>
        </div>
        <div className="mt-1 flex w-full justify-center">
          <TierDiscs tier={tierUp} rail />
        </div>
      </div>

      <div className="-mt-10 flex w-full flex-col items-center gap-3.5 px-6">
        <div className="w-full max-w-sm">
          {summary && summary.tier === tierUp ? (
            <div className="motion-safe:animate-[tier-print_900ms_cubic-bezier(0.16,1,0.3,1)_200ms_both]">
              <TierUpReceipt tier={summary} />
            </div>
          ) : summary === null ? null : (
            // Loading, or still the summary from before this answer.
            <div aria-hidden="true" className="h-[236px] w-full animate-pulse rounded-2xl bg-surface-container-high motion-reduce:animate-none" />
          )}
        </div>
        <p className="m-0 text-center font-body text-xs leading-4 text-on-surface-variant">
          Testnet: test USDC has no cash value.
        </p>
      </div>

      <div className="mx-auto mt-auto flex w-full max-w-sm flex-col gap-1 px-6 pb-5 pt-6">
        <SubmitButton label="See New Tasks" onClick={onSeeTasks} />
        <button
          type="button"
          onClick={onHome}
          className="flex h-11 items-center justify-center rounded-full font-label text-sm font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          Back to home
        </button>
      </div>
    </div>
  );
}
