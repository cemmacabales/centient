import { STAMPS, type StampDef } from "@/lib/gamification/stamps";
import type { StampStatus } from "@/lib/gamification/types";
import { earnedToday, stampCaption } from "./tier-format";

// Earned stamps sit a little crooked, as if pressed by hand; the tilt is fixed
// per position so the grid never reshuffles between renders.
const TILT = [-6, 4, -3, -9, 5, -4, 3, -5, 6, -2, 4, -7];

/** An event code's own stamp, drawn like the twelve (#203). */
function eventDef(s: StampStatus): StampDef | null {
  if (!s.event) return null;
  return { id: s.id, title: s.event.title, icon: s.event.icon, criteria: "From a Centient event.", goal: null, earnable: true };
}

/**
 * #202 (board 07): the twelve stamps, earned ones first and filled, locked ones
 * dashed with their progress. #203: each event stamp held joins them, and the
 * Event slot stays open for the next event.
 */
export default function StampGrid({
  stamps,
  now = new Date(),
  bestRank = null,
}: {
  stamps: StampStatus[];
  now?: Date;
  bestRank?: number | null;
}) {
  const byId = new Map(stamps.map((s) => [s.id, s]));
  const rows = [
    ...STAMPS.map((def) => ({ def, status: byId.get(def.id) ?? { id: def.id, awardedAt: null, progress: null } })),
    ...stamps.flatMap((status) => {
      const def = eventDef(status);
      return def ? [{ def, status }] : [];
    }),
  ];
  const earned = rows
    .filter((r) => r.status.awardedAt)
    .sort((a, b) => a.status.awardedAt!.localeCompare(b.status.awardedAt!));
  const locked = rows.filter((r) => !r.status.awardedAt);

  return (
    <ul className="m-0 grid list-none grid-cols-3 gap-x-3 gap-y-[18px] p-0 pt-1">
      {[...earned, ...locked].map(({ def, status }, i) => {
        const caption = stampCaption(def.id, status, now, bestRank);
        const isNew = status.awardedAt !== null && earnedToday(status.awardedAt, now);
        const label = status.awardedAt
          ? `${def.title}, earned ${caption}`
          : `${def.title}, locked: ${def.criteria}${status.progress ? ` ${caption}` : ""}`;
        return (
          <li key={def.id} aria-label={label} className="relative flex flex-col items-center gap-1.5 text-center">
            {isNew && (
              <span className="absolute -top-1.5 right-0.5 z-10 rounded-full bg-tertiary px-[7px] py-0.5 font-label text-[10px] font-bold uppercase leading-[14px] tracking-[0.08em] text-on-tertiary">
                New
              </span>
            )}
            {status.awardedAt ? (
              <div
                aria-hidden="true"
                className={`h-[72px] w-[72px] rounded-full border-[2.5px] border-tertiary p-1 ${isNew ? "shadow-[0_8px_20px_-6px_rgba(73,75,214,0.45)]" : ""}`}
                style={{ transform: `rotate(${TILT[i % TILT.length]}deg)` }}
              >
                <div
                  className={`flex h-full w-full items-center justify-center rounded-full border-[1.5px] border-dashed ${
                    isNew ? "border-on-tertiary bg-tertiary" : "border-tertiary bg-tertiary-fixed"
                  }`}
                >
                  <span
                    className={`material-symbols-outlined text-[26px] ${isNew ? "text-on-tertiary" : "text-on-tertiary-fixed-variant"}`}
                  >
                    {def.icon}
                  </span>
                </div>
              </div>
            ) : (
              <div
                aria-hidden="true"
                className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-[1.5px] border-dashed border-outline-variant"
              >
                <span className="material-symbols-outlined text-[26px] text-outline">{def.icon}</span>
              </div>
            )}
            <span
              aria-hidden="true"
              className={`text-balance font-label text-xs leading-4 ${status.awardedAt ? "font-bold text-on-surface" : "font-semibold text-on-surface-variant"}`}
            >
              {def.title}
            </span>
            <span aria-hidden="true" className="font-body text-[11px] leading-[14px] text-on-surface-variant">
              {caption}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
