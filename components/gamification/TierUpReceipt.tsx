import type { TierSummary } from "@/lib/gamification/types";
import { formatXp } from "./format";
import { keepOpenLine, payRange } from "./tier-format";

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 font-body text-sm leading-5">
      <span className="text-on-surface-variant">{name}</span>
      <span aria-hidden="true" className="flex-1 border-b-2 border-dotted border-outline-variant" />
      <span className="text-on-surface">{children}</span>
    </div>
  );
}

/**
 * #202 (board 06): what a new tier opened, as a stub torn at both ends. Pay is
 * gold and XP indigo, as everywhere; the dashed rule sets off the rule that
 * keeps the tier open.
 */
export default function TierUpReceipt({ tier }: { tier: TierSummary }) {
  const band = tier.band;
  const pay = band ? payRange(band.payFrom, band.payTo) : null;
  return (
    <div className="w-full drop-shadow-[0_14px_24px_rgba(7,0,108,0.16)]">
      <div className="receipt-stub flex flex-col gap-3 bg-surface-container-lowest px-5 py-[26px]">
        <span className="font-label text-[11px] font-bold uppercase leading-[15px] tracking-[0.2em] text-outline">
          Now open to you
        </span>
        {band && (
          <>
            <Row name="New tasks">
              <span className="font-semibold tabular-nums">{formatXp(band.tasks)}</span>
            </Row>
            <Row name="Difficulty">
              <span className="font-semibold">{band.difficulty}</span>
            </Row>
            {pay && (
              <Row name="They pay">
                <span className="font-headline font-extrabold tabular-nums text-secondary">{pay} USDC</span>
              </Row>
            )}
            <Row name="XP per answer">
              <span className="font-headline font-extrabold tabular-nums text-tertiary">{band.xp}</span>
            </Row>
          </>
        )}
        <div aria-hidden="true" className="my-0.5 border-t-[1.5px] border-dashed border-outline-variant" />
        <Row name="Keep it open">
          <span className="font-semibold">{keepOpenLine(tier.tier)}</span>
        </Row>
      </div>
    </div>
  );
}
