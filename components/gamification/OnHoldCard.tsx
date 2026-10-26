import type { TierSummary } from "@/lib/gamification/types";
import { holdLine } from "./tier-format";

/**
 * #202 (board 09): a held tier. Information, not an error: indigo, never red.
 * The dots fill as checks pass in a row; the last one reopens the tier.
 */
export default function OnHoldCard({ tier }: { tier: TierSummary }) {
  const passed = Math.min(tier.holdChecksPassed, tier.reopenAfter);
  return (
    <section
      role="status"
      aria-labelledby="hold-heading"
      className="flex w-full flex-col gap-3 rounded-3xl bg-surface-container-lowest p-5 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
    >
      <div className="flex items-center gap-2.5">
        <span className="material-symbols-outlined text-[22px] text-tertiary" aria-hidden="true">
          pause_circle
        </span>
        <h2 id="hold-heading" className="m-0 font-headline text-base font-bold text-on-surface">
          {tier.name} tasks paused
        </h2>
      </div>
      <p className="m-0 font-body text-[13px] leading-[19px] text-on-surface-variant">{holdLine(tier)}</p>
      <div className="flex items-center gap-2">
        {Array.from({ length: tier.reopenAfter }, (_, i) =>
          i < passed ? (
            <span key={i} className="flex h-7 w-7 items-center justify-center rounded-full bg-tertiary">
              <span className="material-symbols-outlined text-[16px] text-on-tertiary" aria-hidden="true">
                check
              </span>
            </span>
          ) : (
            <span key={i} className="h-7 w-7 rounded-full border-[1.5px] border-outline-variant" />
          ),
        )}
        <span className="ml-1 font-label text-[13px] font-semibold text-on-surface">
          {passed} of {tier.reopenAfter} passed
        </span>
      </div>
    </section>
  );
}
