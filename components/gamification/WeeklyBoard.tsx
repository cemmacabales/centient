"use client";

import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import type { BoardView } from "@/lib/gamification/types";
import type { QuestStatus } from "@/lib/gamification/quests";
import BoardList from "./BoardList";
import BoardNameCard from "./BoardNameCard";
import QuestCard from "./QuestCard";
import { BOARD_NOTE, daysLeft, endsLine, weekHeading } from "./social-format";

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" });

/**
 * #203 (board 08): Progress → This week. Loads the board and sends
 * `board_viewed` once it shows. This week's quests sit between the week
 * heading and the board; they come with progress, so they show even when the
 * board can't load.
 */
export default function WeeklyBoard({ quests = [] }: { quests?: QuestStatus[] }) {
  const [board, setBoard] = useState<BoardView | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: BoardView) => {
        if (cancelled) return;
        setBoard(data);
        track("board_viewed", { rank: data.you.rank, placed: data.you.placed, shows_name: data.you.name !== null });
      })
      .catch(() => {
        if (!cancelled) setBoard(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (board === undefined) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-3.5">
        <div className="h-[60px] animate-pulse rounded-2xl bg-surface-container-high motion-reduce:animate-none" />
        <div className="h-[420px] animate-pulse rounded-3xl bg-surface-container-high motion-reduce:animate-none" />
      </div>
    );
  }
  if (board === null) {
    return (
      <>
        <QuestCard quests={quests} />
        <p className="font-body text-sm text-on-surface-variant">The board couldn&apos;t load. Try again in a moment.</p>
      </>
    );
  }

  return (
    <>
      <div className="flex items-end justify-between gap-3 py-1">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 font-headline text-[26px] font-extrabold leading-[30px] tracking-[-0.03em] text-on-surface">
            {weekHeading(board.weekKey)}
          </h2>
          <p className="m-0 font-body text-[13px] leading-[18px] text-on-surface-variant">{endsLine(board.endsDay)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-tertiary-fixed px-3 py-1.5 font-label text-[13px] font-bold text-on-tertiary-fixed-variant">
          {daysLeft(board.endsDay, TODAY.format(new Date()))}
        </span>
      </div>
      <QuestCard quests={quests} />
      <BoardList board={board} />
      <section className="flex gap-3 rounded-2xl bg-tertiary-fixed px-[18px] py-4">
        <span className="material-symbols-outlined shrink-0 text-[22px] text-tertiary" aria-hidden="true">
          info
        </span>
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 font-headline text-[15px] font-bold text-on-tertiary-fixed">How the board works</h3>
          <p className="m-0 font-body text-[13px] leading-[19px] text-on-tertiary-fixed-variant">{BOARD_NOTE}</p>
        </div>
      </section>
      <BoardNameCard
        settings={board.settings}
        onSaved={(settings) => {
          setBoard((b) => {
            if (!b) return b;
            const name = settings.showOnBoard ? settings.displayName : null;
            return {
              ...b,
              settings,
              you: { ...b.you, name },
              rows: b.rows.map((r) => (r.you ? { ...r, name } : r)),
            };
          });
        }}
      />
    </>
  );
}
