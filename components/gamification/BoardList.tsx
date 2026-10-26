import type { BoardRow, BoardView } from "@/lib/gamification/types";
import { boardRowLabel, notPlacedLine, tierChip } from "./social-format";

function Row({ row, last }: { row: BoardRow; last: boolean }) {
  const chip = tierChip(row.tier);
  const top = row.rank <= 3;
  if (row.you) {
    return (
      <li
        aria-current="true"
        aria-label={boardRowLabel(row)}
        className="-mx-0.5 my-0.5 flex h-[58px] items-center gap-3 rounded-2xl bg-tertiary px-3.5 text-on-tertiary shadow-[0_10px_24px_-8px_rgba(73,75,214,0.55)]"
      >
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-on-tertiary font-headline text-xs font-extrabold tabular-nums text-tertiary">
          {row.rank}
        </span>
        <Who name={row.name} you chip={chip} />
        <span aria-hidden="true" className="min-w-3 flex-1 border-b-2 border-dotted border-on-tertiary/45" />
        <span aria-hidden="true" className="shrink-0 font-headline text-[15px] font-extrabold tabular-nums">
          {row.xp} XP
        </span>
      </li>
    );
  }
  return (
    <li
      aria-label={boardRowLabel(row)}
      className={`flex h-[54px] items-center gap-3 px-3 ${last ? "" : "border-b border-outline-variant/30"}`}
    >
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-headline text-xs font-extrabold tabular-nums ${
          top ? "bg-tertiary text-on-tertiary" : "border-[1.5px] border-outline-variant text-on-surface-variant"
        }`}
      >
        {row.rank}
      </span>
      <Who name={row.name} you={false} chip={chip} />
      <span aria-hidden="true" className="min-w-3 flex-1 border-b-2 border-dotted border-outline-variant" />
      <span aria-hidden="true" className="shrink-0 font-headline text-[15px] font-extrabold tabular-nums text-tertiary">
        {row.xp} XP
      </span>
    </li>
  );
}

function Who({ name, you, chip }: { name: string | null; you: boolean; chip: { name: string; className: string } }) {
  return (
    <span aria-hidden="true" className="flex min-w-0 shrink flex-col items-start gap-0.5">
      <span
        className={`max-w-full truncate font-label text-[15px] leading-5 ${
          you ? "font-bold" : name ? "font-semibold text-on-surface" : "font-semibold text-on-surface-variant"
        }`}
      >
        {name ?? "Hidden labeler"}
        {you && " · You"}
      </span>
      <span className={`rounded-full px-[7px] font-label text-[11px] font-bold leading-4 ${chip.className}`}>{chip.name}</span>
    </span>
  );
}

/** #203 (board 08): the week's standings, with your own row marked or added below. */
export default function BoardList({ board }: { board: BoardView }) {
  const { rows, you } = board;
  const ownRow: BoardRow | null =
    !you.inTop && you.rank !== null ? { rank: you.rank, name: you.name, tier: you.tier, xp: you.xp, you: true } : null;

  if (rows.length === 0) {
    return (
      <p className="m-0 rounded-3xl border-[1.5px] border-dashed border-outline-variant px-5 py-6 text-center font-body text-sm leading-[21px] text-on-surface-variant">
        No one&apos;s on the board yet this week. Answer a task to take the first place.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ol
        aria-label="This week's standings"
        className="m-0 flex list-none flex-col rounded-3xl bg-surface-container-lowest px-2 py-1.5 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
      >
        {rows.map((row, i) => (
          <Row key={row.rank} row={row} last={i === rows.length - 1 && !ownRow} />
        ))}
        {ownRow && (
          <>
            <li aria-hidden="true" className="flex h-6 items-center justify-center gap-1">
              {[0, 1, 2].map((d) => (
                <span key={d} className="h-1 w-1 rounded-full bg-outline-variant" />
              ))}
            </li>
            <Row row={ownRow} last />
          </>
        )}
      </ol>
      {!you.placed && (
        <p className="m-0 rounded-2xl bg-tertiary-fixed px-[18px] py-3.5 font-body text-[13px] leading-[19px] text-on-tertiary-fixed-variant">
          {notPlacedLine(you.xp)}
        </p>
      )}
    </div>
  );
}
