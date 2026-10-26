import { TIERS } from "@/lib/gamification/tiers";

/**
 * #202 (boards 03, 06, 07): the four tiers as numbered discs on an indigo
 * surface. Reached tiers are Indigo Mist, the current one is ringed, the rest
 * are hairline rings. `rail` adds the names under each disc and a track behind.
 */
export default function TierDiscs({ tier, rail = false }: { tier: number; rail?: boolean }) {
  const size = rail ? "h-8 w-8 text-[13px]" : "h-[22px] w-[22px] text-[11px]";
  const ring = rail
    ? "shadow-[0_0_0_4px_var(--color-tertiary),0_0_0_6px_var(--color-on-tertiary)]"
    : "shadow-[0_0_0_2px_var(--color-tertiary),0_0_0_3.5px_var(--color-on-tertiary)]";

  const discs = TIERS.map((t) => {
    const state = t.id < tier ? "reached" : t.id === tier ? "current" : "ahead";
    const look =
      state === "reached"
        ? "bg-tertiary-fixed text-on-tertiary-fixed-variant"
        : state === "current"
          ? `bg-tertiary-container text-on-tertiary-fixed ${ring}`
          : "border-[1.5px] border-on-tertiary/50 bg-tertiary text-tertiary-fixed";
    const disc = (
      <span
        className={`flex shrink-0 items-center justify-center rounded-full font-headline font-extrabold tabular-nums ${size} ${look}`}
      >
        {t.id + 1}
      </span>
    );
    if (!rail) return <span key={t.id}>{disc}</span>;
    return (
      <div key={t.id} className="relative z-10 flex flex-col items-center gap-1.5">
        {disc}
        <span
          className={`font-label text-[11px] ${state === "current" ? "font-extrabold text-on-tertiary" : "font-semibold text-tertiary-fixed"}`}
        >
          {t.name}
        </span>
      </div>
    );
  });

  if (!rail) {
    return (
      <div aria-label={`Tier ${tier + 1} of ${TIERS.length}`} role="img" className="flex items-center gap-1.5">
        {discs}
      </div>
    );
  }
  // The track runs disc centre to disc centre; its filled part reaches the current tier.
  const span = TIERS.length - 1;
  return (
    <div aria-label={`Tier ${tier + 1} of ${TIERS.length}`} role="img" className="relative w-full max-w-[300px]">
      <div aria-hidden="true" className="absolute left-[12.5%] right-[12.5%] top-[15px] h-0.5 bg-on-tertiary/35">
        <div className="h-full bg-on-tertiary" style={{ width: `${(tier / span) * 100}%` }} />
      </div>
      <div className="grid grid-cols-4">{discs}</div>
    </div>
  );
}
