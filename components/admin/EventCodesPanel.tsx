"use client";

import { useEffect, useState } from "react";
import { EVENT_CODE_XP, EVENT_ICONS, EVENT_RULES, type EventCodeField } from "@/lib/gamification/events";
import type { EventCodeRow } from "@/lib/gamification/redeem";
import { dayRange } from "@/components/gamification/social-format";

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" });
const COUNT = new Intl.NumberFormat("en-US");

const FIELD_ERROR: Record<EventCodeField, string> = {
  code: `Use ${EVENT_RULES.codeMin} to ${EVENT_RULES.codeMax} letters and numbers, no spaces.`,
  stampTitle: `Give the stamp a name of ${EVENT_RULES.titleMin} to ${EVENT_RULES.titleMax} characters.`,
  stampIcon: "Pick one of the icons.",
  startsDay: "Pick the first day.",
  endsDay: `The last day can't be before the first, or more than ${EVENT_RULES.maxDays} days after it.`,
};

const input =
  "h-11 w-full rounded-xl border-[1.5px] border-outline-variant bg-surface-container-lowest px-3 font-body text-sm text-on-surface caret-primary focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";

/** #203 (board 10): event codes, newest first, and a form for a new one. */
export default function EventCodesPanel() {
  const [codes, setCodes] = useState<EventCodeRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", stampTitle: "", stampIcon: "festival", startsDay: "", endsDay: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/event-codes")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { codes: EventCodeRow[] }) => !cancelled && setCodes(data.codes))
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/event-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 400 && data?.field) return setError(FIELD_ERROR[data.field as EventCodeField]);
      if (res.status === 409) return setError("That code exists already. Choose another.");
      if (!res.ok) throw new Error(String(res.status));
      setCodes((c) => [{ ...data, createdAt: new Date().toISOString() }, ...(c ?? [])]);
      setForm({ code: "", stampTitle: "", stampIcon: "festival", startsDay: "", endsDay: "" });
      setOpen(false);
    } catch {
      setError("Couldn't create the code. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const today = TODAY.format(new Date());
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section
      aria-labelledby="event-codes-heading"
      className="flex flex-col gap-4 rounded-3xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_4px_24px_rgba(25,28,30,0.04)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="event-codes-heading" className="font-headline text-xl font-bold text-on-surface">
            Event codes
          </h2>
          <p className="max-w-2xl font-body text-sm leading-[21px] text-on-surface-variant">
            Each code gives one event stamp and {EVENT_CODE_XP} XP. One per account, signed-in wallet only, inside its dates.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex h-10 items-center gap-1.5 rounded-full bg-primary px-4 font-label text-sm font-bold text-on-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              add
            </span>
            New code
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={create} className="grid gap-3 rounded-2xl bg-surface-container-low p-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 font-label text-xs font-semibold text-on-surface-variant">
            Code
            <input className={`${input} font-mono uppercase`} value={form.code} onChange={set("code")} placeholder="WEBINAR1" required autoFocus />
          </label>
          <label className="flex flex-col gap-1.5 font-label text-xs font-semibold text-on-surface-variant">
            Stamp name
            <input className={input} value={form.stampTitle} onChange={set("stampTitle")} placeholder="Contributor webinar" required />
          </label>
          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="mb-1.5 font-label text-xs font-semibold text-on-surface-variant">Stamp icon</legend>
            <div className="flex flex-wrap gap-2">
              {EVENT_ICONS.map((icon) => (
                <label
                  key={icon}
                  className={`flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-[1.5px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary ${
                    form.stampIcon === icon ? "border-tertiary bg-tertiary-fixed text-on-tertiary-fixed-variant" : "border-outline-variant text-outline"
                  }`}
                >
                  <input type="radio" name="stampIcon" value={icon} checked={form.stampIcon === icon} onChange={set("stampIcon")} className="sr-only" aria-label={icon.replace(/_/g, " ")} />
                  <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                    {icon}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1.5 font-label text-xs font-semibold text-on-surface-variant">
            First day (Manila)
            <input type="date" className={input} value={form.startsDay} onChange={set("startsDay")} required />
          </label>
          <label className="flex flex-col gap-1.5 font-label text-xs font-semibold text-on-surface-variant">
            Last day (Manila)
            <input type="date" className={input} value={form.endsDay} min={form.startsDay || undefined} onChange={set("endsDay")} required />
          </label>
          {error && (
            <p role="alert" className="font-label text-xs font-semibold text-error sm:col-span-2">
              {error}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="h-10 rounded-full bg-primary px-5 font-label text-sm font-bold text-on-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-60"
            >
              {saving ? "Creating…" : "Create code"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="h-10 rounded-full px-4 font-label text-sm font-semibold text-on-surface-variant hover:bg-surface-container-high"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loadError ? (
        <p role="alert" className="font-label text-xs font-semibold text-error">
          Couldn&apos;t load the codes. Reload to try again.
        </p>
      ) : codes === null ? (
        <div aria-hidden="true" className="h-24 animate-pulse rounded-xl bg-surface-container-high motion-reduce:animate-none" />
      ) : codes.length === 0 ? (
        <p className="rounded-xl border-[1.5px] border-dashed border-outline-variant px-4 py-5 text-center font-body text-sm text-on-surface-variant">
          No codes yet. Create one for the next booth or webinar.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse font-body text-sm leading-5">
            <thead>
              <tr className="text-left font-label text-[11px] font-bold uppercase tracking-[0.12em] text-outline">
                <th className="pb-2 font-bold">Code</th>
                <th className="pb-2 font-bold">Stamp</th>
                <th className="pb-2 font-bold">Dates</th>
                <th className="pb-2 text-right font-bold">Redeemed</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-t border-outline-variant/40">
                  <td className="py-2.5 font-mono text-[13px] font-semibold text-on-surface">{c.code}</td>
                  <td className="py-2.5">
                    <span className="flex items-center gap-2 text-on-surface">
                      <span className="material-symbols-outlined text-[18px] text-tertiary" aria-hidden="true">
                        {c.stampIcon}
                      </span>
                      {c.stampTitle}
                    </span>
                  </td>
                  <td className="py-2.5 tabular-nums text-on-surface-variant">{dayRange(c.startsDay, c.endsDay)}</td>
                  <td className="py-2.5 text-right font-semibold tabular-nums text-on-surface">
                    {today < c.startsDay ? <span className="font-normal text-on-surface-variant">Not started</span> : COUNT.format(c.redeemed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
