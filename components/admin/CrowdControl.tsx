"use client";

import { useEffect, useState } from "react";

// #202 (board 10): who a campaign's tasks go to. Expert-only campaigns are a
// later decision, shown disabled so the ladder reads whole.
const OPTIONS = [
  { value: 0, label: "Everyone" },
  { value: 1, label: "Skilled and up" },
  { value: 2, label: "Trusted and up" },
] as const;

interface CrowdControlProps {
  campaignId: string;
  canManage: boolean;
}

interface CrowdState {
  minTier: number;
  qualifyingLabelers: Record<string, number>;
}

const COUNT = new Intl.NumberFormat("en-US");

export default function CrowdControl({ campaignId, canManage }: CrowdControlProps) {
  const [state, setState] = useState<CrowdState | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/campaigns/${campaignId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: CrowdState) => {
        if (!cancelled) setState({ minTier: data.minTier, qualifyingLabelers: data.qualifyingLabelers });
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the crowd setting.");
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  async function choose(minTier: number) {
    if (!state || minTier === state.minTier || saving !== null) return;
    setSaving(minTier);
    setError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minTier }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState({ ...state, minTier });
    } catch {
      setError("Couldn't save the crowd. Try again.");
    } finally {
      setSaving(null);
    }
  }

  const qualify = state ? state.qualifyingLabelers[String(state.minTier)] : undefined;

  return (
    <section
      aria-labelledby="crowd-heading"
      className="flex flex-col gap-4 rounded-3xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_4px_24px_rgba(25,28,30,0.04)]"
    >
      <div className="flex flex-col gap-1">
        <h2 id="crowd-heading" className="font-headline text-xl font-bold text-on-surface">
          Crowd
        </h2>
        <p className="max-w-2xl font-body text-sm leading-[21px] text-on-surface-variant">
          Send this campaign&apos;s tasks only to labelers at this tier or above. A smaller crowd answers more slowly.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-labelledby="crowd-heading"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {OPTIONS.map((o) => {
          const checked = state?.minTier === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={!canManage || !state || saving !== null}
              onClick={() => choose(o.value)}
              className={`min-h-12 rounded-xl px-3 py-2.5 font-label text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed ${
                checked
                  ? "bg-primary font-bold text-on-primary"
                  : "border-[1.5px] border-outline-variant bg-surface-container-lowest font-semibold text-on-surface-variant enabled:hover:bg-surface-container-low disabled:opacity-60"
              }`}
            >
              {saving === o.value ? "Saving…" : o.label}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={false}
          disabled
          className="min-h-12 cursor-not-allowed rounded-xl border-[1.5px] border-dashed border-outline-variant bg-surface-container-low px-3 py-2.5 font-label text-sm font-semibold text-outline"
        >
          Expert only · later
        </button>
      </div>

      {error && (
        <p role="alert" className="font-label text-xs font-semibold text-error">
          {error}
        </p>
      )}

      <table className="w-full border-collapse font-body text-sm leading-5">
        <tbody>
          <tr className="border-t border-outline-variant/40">
            <td className="py-2.5 text-on-surface-variant">Labelers who qualify now</td>
            <td className="py-2.5 text-right font-semibold tabular-nums text-on-surface">
              {qualify === undefined ? "…" : COUNT.format(qualify)}
            </td>
          </tr>
          <tr className="border-t border-outline-variant/40">
            <td className="py-2.5 text-on-surface-variant">CSV upload</td>
            <td className="py-2.5 text-right font-semibold text-on-surface">Optional difficulty column, 1–9</td>
          </tr>
          <tr className="border-t border-outline-variant/40">
            <td className="py-2.5 text-on-surface-variant">Tasks with no difficulty</td>
            <td className="py-2.5 text-right font-semibold text-on-surface">Open to every tier</td>
          </tr>
          <tr className="border-t border-outline-variant/40">
            <td className="py-2.5 text-on-surface-variant">Export</td>
            <td className="py-2.5 text-right font-semibold text-on-surface">Adds a labeler_tier column</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
