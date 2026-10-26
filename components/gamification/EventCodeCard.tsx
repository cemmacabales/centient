"use client";

import { useState } from "react";
import { normalizeCode } from "@/lib/gamification/events";
import { redeemError, type RedeemFailure } from "./social-format";

export interface Redeemed {
  code: string;
  stamp: { id: string; title: string; icon: string };
  xp: number;
  xpTotal: number;
}

interface EventCodeCardProps {
  /** A code from a booth link (`?code=`), waiting for the labeler to add it. */
  initialCode?: string | null;
  onRedeemed: (r: Redeemed) => void;
}

/**
 * #203 (board 07): add an event code for its stamp and 25 XP. A code from a
 * link arrives filled in; tapping Add is the confirmation, so nothing is
 * redeemed without the labeler asking.
 */
export default function EventCodeCard({ initialCode = null, onRedeemed }: EventCodeCardProps) {
  const [code, setCode] = useState(initialCode ?? "");
  const [fromLink, setFromLink] = useState(Boolean(initialCode));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RedeemFailure | null>(null);
  const [added, setAdded] = useState<Redeemed | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const normal = normalizeCode(code);
    if (!normal) {
      setError("unknown_code");
      return;
    }
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const res = await fetch("/api/me/event-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normal }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError((data?.error as RedeemFailure) ?? "network");
        return;
      }
      setAdded(data as Redeemed);
      setCode("");
      setFromLink(false);
      onRedeemed(data as Redeemed);
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="event-code" className="mt-1.5 flex flex-col gap-2.5 rounded-3xl bg-tertiary-fixed p-5">
      <label htmlFor="event-code-input" className="font-headline text-base font-bold text-on-tertiary-fixed">
        Event code
      </label>
      <p className="m-0 font-body text-[13px] leading-[18px] text-on-tertiary-fixed-variant">
        Got a code at a Centient booth? Add it for that event&apos;s stamp.
      </p>
      <form onSubmit={submit} className="flex gap-2">
        <input
          id="event-code-input"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={24}
          placeholder="e.g. BQF2026"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
            setAdded(null);
          }}
          aria-describedby="event-code-status"
          aria-invalid={error ? true : undefined}
          autoFocus={fromLink}
          className="h-12 min-w-0 flex-1 rounded-xl border-0 bg-surface-container-lowest px-4 font-body text-sm uppercase text-on-surface caret-tertiary placeholder:normal-case placeholder:text-outline focus:outline-none focus-visible:ring-2 focus-visible:ring-tertiary"
        />
        <button
          type="submit"
          disabled={busy || code.trim() === ""}
          className="h-12 shrink-0 rounded-full bg-primary px-5 font-label text-sm font-bold text-on-primary transition-opacity focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-tertiary-fixed disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
      <p id="event-code-status" role="status" aria-live="polite" className="m-0 min-h-0 font-body text-[13px] leading-[18px] text-on-tertiary-fixed-variant empty:hidden">
        {error ? redeemError(error) : added ? null : fromLink ? "From your link. Tap Add to collect it." : null}
      </p>
      {added && (
        <p className="m-0 flex items-center gap-2 font-label text-[13px] font-semibold text-on-tertiary-fixed">
          <span className="material-symbols-outlined text-[18px] text-tertiary" aria-hidden="true">
            {added.stamp.icon}
          </span>
          {added.stamp.title} stamp added, and {added.xp} XP.
        </p>
      )}
    </section>
  );
}
