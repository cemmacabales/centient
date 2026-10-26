import Image from "next/image";
import type { TierSummary } from "@/lib/gamification/types";
import { formatXp } from "./format";
import { nextLine } from "./tier-format";
import TierDiscs from "./TierDiscs";

interface TierCardProps {
  tier: TierSummary;
  xpTotal: number;
  /** Progress (board 07) adds the owl and the receipt rows; Home (board 03) leaves them out. */
  detail?: { streakDays: number; restDays: number };
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 font-body text-sm leading-5">
      <span className="text-tertiary-fixed">{name}</span>
      <span aria-hidden="true" className="flex-1 border-b-2 border-dotted border-on-tertiary/40" />
      <span className="font-semibold tabular-nums text-on-tertiary">{children}</span>
    </div>
  );
}

const NONE = "None yet";

/**
 * #202: the labeler's tier on the indigo progress surface. It replaces #201's
 * XP card: the XP total sits under the tier, over a bar to the next one.
 */
export default function TierCard({ tier, xpTotal, detail }: TierCardProps) {
  const next = tier.next;
  const name = (
    <div className="flex flex-col gap-0.5">
      <span className="font-label text-[11px] font-bold uppercase leading-[15px] tracking-[0.2em] text-tertiary-fixed">
        Tier
      </span>
      <span
        className={`font-headline font-extrabold tracking-[-0.03em] text-on-tertiary ${detail ? "text-[28px] leading-[30px]" : "text-[26px] leading-[30px]"}`}
      >
        {tier.name}
      </span>
    </div>
  );

  return (
    <section
      aria-label="Your tier"
      className="flex w-full flex-col gap-3.5 rounded-3xl bg-tertiary p-5 text-on-tertiary shadow-[0_14px_32px_-10px_rgba(73,75,214,0.55)]"
    >
      {detail ? (
        <div className="flex items-center gap-3">
          <span className="flex h-15 w-15 shrink-0 items-center justify-center rounded-full bg-tertiary-fixed">
            <Image src="/mascot/owl-chart.webp" alt="" width={52} height={52} className="h-13 w-13 select-none" />
          </span>
          <div className="flex-1">{name}</div>
          <TierDiscs tier={tier.tier} />
        </div>
      ) : (
        <div className="flex items-start justify-between">
          {name}
          <div className="pt-1">
            <TierDiscs tier={tier.tier} />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-headline text-xl font-extrabold tracking-[-0.03em] tabular-nums">{formatXp(xpTotal)} XP</span>
          {next && (
            <span className="font-body text-[13px] text-tertiary-fixed">
              {detail ? `${formatXp(next.xpToGo)} to ${next.name}` : `${formatXp(next.xp)} for ${next.name}`}
            </span>
          )}
        </div>
        {next && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={next.xp}
            aria-valuenow={Math.min(xpTotal, next.xp)}
            aria-label={`XP toward ${next.name}`}
            className="h-2 overflow-hidden rounded-full bg-on-tertiary/20"
          >
            <div
              className="h-full rounded-full bg-on-tertiary transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
              style={{ width: `${Math.min(100, (xpTotal / next.xp) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {detail ? (
        <>
          <div aria-hidden="true" className="border-t-[1.5px] border-dashed border-on-tertiary/40" />
          <div className="flex flex-col gap-2.5">
            <Row name="Quality checks">
              {tier.checks.total ? `${tier.checks.passed} of last ${tier.checks.total}` : NONE}
            </Row>
            <Row name="Matched the crowd">
              {tier.crowd.total ? `${Math.round((tier.crowd.matched / tier.crowd.total) * 100)}%` : NONE}
            </Row>
            <Row name="Answers">{formatXp(tier.answers)}</Row>
            <Row name="Streak">
              {detail.streakDays
                ? `${detail.streakDays} day${detail.streakDays === 1 ? "" : "s"}${
                    detail.restDays ? ` · ${detail.restDays} rest day${detail.restDays === 1 ? "" : "s"}` : ""
                  }`
                : NONE}
            </Row>
          </div>
        </>
      ) : (
        <p className="m-0 font-body text-[13px] leading-[19px] text-tertiary-fixed">
          <NextLine tier={tier} />
        </p>
      )}
    </section>
  );
}

/** The pay ceiling is money, so it's gold even on indigo (board 03). */
function NextLine({ tier }: { tier: TierSummary }) {
  const line = nextLine(tier);
  const pay = tier.next?.payUpTo ? `${Number(tier.next.payUpTo).toFixed(2)} USDC` : null;
  if (!pay || !line.includes(pay)) return <>{line}</>;
  const [before, after] = line.split(pay);
  return (
    <>
      {before}
      <b className="font-headline font-extrabold text-secondary-fixed">{pay}</b>
      {after}
    </>
  );
}
