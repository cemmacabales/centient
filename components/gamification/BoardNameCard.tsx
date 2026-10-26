"use client";

import { useState } from "react";
import { NAME_RULES } from "@/lib/gamification/names";
import type { BoardView } from "@/lib/gamification/types";
import { nameError, type NameFailure } from "./social-format";

type Settings = BoardView["settings"];

/**
 * #203 (board 08): "Show my name" and the name itself. Names are opt-in; with
 * no name, or showing turned off, the board says "Hidden labeler". After an
 * admin hide the card asks for another name, in indigo, never red.
 */
export default function BoardNameCard({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [editing, setEditing] = useState(settings.nameHidden);
  const [draft, setDraft] = useState("");
  const [showAfter, setShowAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NameFailure | null>(null);

  async function save(body: { displayName?: string; showOnBoard?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError((data?.error as NameFailure) ?? "network");
        return false;
      }
      onSaved(data as Settings);
      return true;
    } catch {
      setError("network");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    if (busy) return;
    if (!settings.showOnBoard && !settings.displayName) {
      setShowAfter(true);
      setDraft("");
      setEditing(true);
      return;
    }
    void save({ showOnBoard: !settings.showOnBoard });
  }

  async function submitName(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const ok = await save({ displayName: draft, ...(showAfter || settings.nameHidden ? { showOnBoard: true } : {}) });
    if (ok) {
      setEditing(false);
      setShowAfter(false);
    }
  }

  const line = settings.displayName
    ? settings.showOnBoard
      ? `Showing as ${settings.displayName}.`
      : `Others see Hidden labeler.`
    : "Choose a name to show on the board.";

  return (
    <div className="flex flex-col gap-3">
      {settings.nameHidden && (
        <p className="m-0 flex gap-3 rounded-2xl bg-tertiary-fixed px-[18px] py-3.5 font-body text-[13px] leading-[19px] text-on-tertiary-fixed-variant">
          <span className="material-symbols-outlined shrink-0 text-[20px] text-tertiary" aria-hidden="true">
            badge
          </span>
          Your board name was hidden by the Centient team. Choose another to show on the board.
        </p>
      )}
      <section className="flex flex-col gap-3 rounded-2xl bg-surface-container-lowest px-[18px] py-4 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span id="show-name-label" className="font-label text-[15px] font-semibold text-on-surface">
              Show my name
            </span>
            <span className="font-body text-[13px] leading-[18px] text-on-surface-variant">
              {line}{" "}
              {!editing && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(settings.displayName ?? "");
                    setEditing(true);
                  }}
                  className="rounded font-semibold text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {settings.displayName ? "Edit name" : "Choose name"}
                </button>
              )}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.showOnBoard}
            aria-labelledby="show-name-label"
            onClick={toggle}
            disabled={busy}
            className={`relative h-8 w-[52px] shrink-0 rounded-full transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-60 ${
              settings.showOnBoard ? "bg-primary" : "bg-surface-container-highest"
            }`}
          >
            <span
              aria-hidden="true"
              className={`absolute top-1 h-6 w-6 rounded-full bg-surface-container-lowest shadow-[0_1px_3px_rgba(25,28,30,0.2)] transition-[left] duration-200 ease-out motion-reduce:transition-none ${
                settings.showOnBoard ? "left-6" : "left-1"
              }`}
            />
          </button>
        </div>

        {editing && (
          <form onSubmit={submitName} className="flex flex-col gap-2 border-t border-dashed border-outline-variant pt-3">
            <label htmlFor="board-name" className="font-label text-[13px] font-semibold text-on-surface-variant">
              Board name
            </label>
            <div className="flex gap-2">
              <input
                id="board-name"
                type="text"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                maxLength={NAME_RULES.max + 4}
                placeholder="e.g. tala.labels"
                value={draft}
                autoFocus
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                aria-describedby="board-name-help"
                aria-invalid={error ? true : undefined}
                className="h-12 min-w-0 flex-1 rounded-xl border-0 bg-surface-container-low px-4 font-body text-sm lowercase text-on-surface caret-primary placeholder:text-outline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <button
                type="submit"
                disabled={busy || draft.trim() === ""}
                className="h-12 shrink-0 rounded-full bg-primary px-5 font-label text-sm font-bold text-on-primary transition-opacity focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
            <p id="board-name-help" role="status" aria-live="polite" className="m-0 font-body text-[13px] leading-[18px] text-on-surface-variant">
              {error
                ? nameError(error)
                : `${NAME_RULES.min} to ${NAME_RULES.max} letters, numbers, dots or underscores. Others see it on the board.`}
            </p>
            {!settings.nameHidden && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setShowAfter(false);
                  setError(null);
                }}
                className="self-start rounded font-label text-[13px] font-semibold text-on-surface-variant underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary"
              >
                Cancel
              </button>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
