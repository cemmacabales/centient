"use client";

import { useEffect, useState } from "react";
import type { AdminBoardRow } from "@/lib/gamification/leaderboard";
import { tierChip, weekHeading } from "@/components/gamification/social-format";

/**
 * #203 (board 10): this week's top rows. Hiding a name asks first: the name is
 * retired for good, and its owner is asked to choose another.
 */
export default function WeeklyBoardPanel() {
  const [board, setBoard] = useState<{ weekKey: string; rows: AdminBoardRow[] } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [hiding, setHiding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/board")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => !cancelled && setBoard(data))
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, []);

  async function hide(userId: string) {
    setHiding(userId);
    setError(null);
    try {
      const res = await fetch("/api/admin/board/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setBoard((b) => b && { ...b, rows: b.rows.map((r) => (r.userId === userId ? { ...r, name: null, optedOut: false } : r)) });
      setHidden((h) => new Set(h).add(userId));
    } catch {
      setError("Couldn't hide the name. Try again.");
    } finally {
      setHiding(null);
      setConfirming(null);
    }
  }
  return (
    <section
      aria-labelledby="weekly-board-heading"
      className="flex flex-col gap-4 rounded-3xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_4px_24px_rgba(25,28,30,0.04)]"
    >
      <div className="flex flex-col gap-1">
        <h2 id="weekly-board-heading" className="font-headline text-xl font-bold text-on-surface">
          Weekly board{board ? ` · ${weekHeading(board.weekKey)}` : ""}
        </h2>
        <p className="max-w-2xl font-body text-sm leading-[21px] text-on-surface-variant">
          Hiding a name shows it as Hidden labeler and asks the labeler to choose another. Every hide goes to the audit log.
        </p>
      </div>
      {error && (
        <p role="alert" className="font-label text-xs font-semibold text-error">
          {error}
        </p>
      )}
      {loadError ? (
        <p role="alert" className="font-label text-xs font-semibold text-error">
          Couldn&apos;t load the board. Reload to try again.
        </p>
      ) : board === null ? (
        <div aria-hidden="true" className="h-32 animate-pulse rounded-xl bg-surface-container-high motion-reduce:animate-none" />
      ) : board.rows.length === 0 ? (
        <p className="rounded-xl border-[1.5px] border-dashed border-outline-variant px-4 py-5 text-center font-body text-sm text-on-surface-variant">
          No one has placed this week yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse font-body text-sm leading-5">
            <thead>
              <tr className="text-left font-label text-[11px] font-bold uppercase tracking-[0.12em] text-outline">
                <th className="w-10 pb-2 font-bold">#</th>
                <th className="pb-2 font-bold">Name</th>
                <th className="pb-2 font-bold">Tier</th>
                <th className="pb-2 text-right font-bold">XP</th>
                <th className="pb-2 text-right font-bold">Action</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => {
                const chip = tierChip(r.tier);
                return (
                  <tr key={r.userId} className="border-t border-outline-variant/40">
                    <td className="py-2.5 font-headline font-extrabold tabular-nums text-on-surface-variant">{r.rank}</td>
                    <td className={`py-2.5 ${r.name ? "font-semibold text-on-surface" : "text-on-surface-variant"}`}>{r.name ?? "Hidden labeler"}</td>
                    <td className="py-2.5">
                      <span className={`rounded-full px-2 py-0.5 font-label text-[11px] font-bold ${chip.className}`}>{chip.name}</span>
                    </td>
                    <td className="py-2.5 text-right font-headline font-extrabold tabular-nums text-tertiary">{r.xp}</td>
                    <td className="py-2.5 text-right">
                      {hidden.has(r.userId) ? (
                        <span className="text-on-surface-variant">Hidden</span>
                      ) : r.optedOut ? (
                        <span className="text-on-surface-variant">Opted out</span>
                      ) : confirming === r.userId ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={hiding !== null}
                            onClick={() => hide(r.userId)}
                            className="h-9 rounded-full bg-error px-3 font-label text-xs font-bold text-on-primary focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 disabled:opacity-60"
                          >
                            {hiding === r.userId ? "Hiding…" : `Hide ${r.name}`}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="h-9 rounded-full px-3 font-label text-xs font-semibold text-on-surface-variant hover:bg-surface-container-low"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirming(r.userId)}
                          className="h-9 rounded-full border-[1.5px] border-outline-variant px-3 font-label text-xs font-semibold text-on-surface hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          Hide name
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
