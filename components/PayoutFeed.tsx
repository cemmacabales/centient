"use client";

import { useEffect, useRef, useState } from "react";
import type { RecentPayout, RecentPayoutsResult } from "@/lib/recent-payouts";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";

const POLL_MS = 30_000;

type Feed =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: RecentPayoutsResult; fresh: ReadonlySet<string> };

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-low";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 weeks ago", "yesterday", "just now". */
function ago(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function Leader() {
  return <span className="mx-2 h-px flex-1 translate-y-1 border-b border-dotted border-outline-variant" />;
}

/** One payout as a torn-off receipt stub. */
function Stub({ payout, fresh, now }: { payout: RecentPayout; fresh: boolean; now: number }) {
  return (
    <li
      className={`w-[15.5rem] shrink-0 snap-start lg:w-auto ${
        fresh ? "motion-safe:animate-[landing-stub-in_700ms_cubic-bezier(0.16,1,0.3,1)_both]" : ""
      }`}
    >
      <a
        href={payout.txUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`group block h-full rounded-sm transition-[translate,filter] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] drop-shadow-[0_8px_18px_rgba(25,28,30,0.08)] hover:-translate-y-1 hover:drop-shadow-[0_16px_28px_rgba(25,28,30,0.12)] ${FOCUS}`}
      >
        <span className="receipt-stub relative flex h-full flex-col bg-surface-container-lowest px-5 pb-6 pt-6">
          {fresh && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-secondary-fixed/50 motion-safe:animate-[landing-fade-out_1800ms_ease-out_both] motion-reduce:hidden"
            />
          )}
          <span className="flex items-baseline justify-between gap-3">
            <span className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">Paid</span>
            <time dateTime={payout.at} className="font-label text-xs text-outline">
              {ago(payout.at, now)}
            </time>
          </span>
          <span className="mt-2 flex items-baseline gap-1 text-secondary">
            <span className="font-headline text-3xl font-extrabold tracking-tighter tabular-nums">{payout.amount}</span>
            <span className="font-headline text-sm font-bold">{REWARD_TOKEN_SYMBOL}</span>
          </span>
          <span className="mt-4 flex flex-col gap-1.5 font-label text-xs text-on-surface-variant">
            <span className="flex items-center">
              To
              <Leader />
              <span className="font-mono text-on-surface">{payout.to}</span>
            </span>
            <span className="flex items-center">
              Tx
              <Leader />
              <span className="font-mono text-on-surface">{payout.tx}</span>
            </span>
          </span>
          <span className="mt-4 flex items-center justify-between border-t border-dashed border-outline-variant pt-3 font-label text-xs font-semibold">
            <span className="flex items-center gap-1 text-primary">
              <span
                className="material-symbols-outlined text-[15px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
                aria-hidden="true"
              >
                verified
              </span>
              Confirmed
            </span>
            <span className="flex items-center gap-0.5 text-on-surface-variant transition-colors group-hover:text-primary">
              View
              <span
                className="material-symbols-outlined text-[16px] transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                aria-hidden="true"
              >
                arrow_outward
              </span>
            </span>
          </span>
          <span className="sr-only"> transaction on stellar.expert (opens in a new tab)</span>
        </span>
      </a>
    </li>
  );
}

/**
 * Recent USDC payouts from Centient's payout account, read from the Stellar
 * ledger through `/api/payouts/recent`. Each stub opens its transaction on
 * stellar.expert. The feed checks for new payouts every 30 seconds while it is
 * on screen, and a payout it had not shown before slides in at the front, its
 * paper briefly gold.
 */
export default function PayoutFeed() {
  const [feed, setFeed] = useState<Feed>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const sectionRef = useRef<HTMLElement>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let timer = 0;
    let inView = false;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/payouts/recent");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as RecentPayoutsResult;
        if (cancelled) return;
        // The first load has nothing to compare against, so nothing is "new".
        const fresh = new Set(seen.current ? data.payouts.filter((p) => !seen.current!.has(p.id)).map((p) => p.id) : []);
        seen.current = new Set(data.payouts.map((p) => p.id));
        setFeed({ status: "ready", data, fresh });
      } catch {
        if (!cancelled) setFeed((prev) => (prev.status === "ready" ? prev : { status: "error" }));
      }
      if (!cancelled) setNow(Date.now());
    };

    const schedule = () => {
      window.clearInterval(timer);
      if (inView && document.visibilityState === "visible") {
        timer = window.setInterval(load, POLL_MS);
      }
    };

    void load();
    const io = new IntersectionObserver(([entry]) => {
      const wasInView = inView;
      inView = entry.isIntersecting;
      // Coming back into view after a while: catch up right away.
      if (inView && !wasInView && seen.current) void load();
      schedule();
    });
    io.observe(section);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      io.disconnect();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);

  const accountUrl = feed.status === "ready" ? feed.data.accountUrl : null;

  return (
    <section
      ref={sectionRef}
      id="payouts"
      aria-labelledby="payouts-heading"
      className="scroll-mt-20 bg-surface-container-low py-20 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
          <div className="max-w-[36rem]">
            <h2
              id="payouts-heading"
              className="font-headline text-3xl font-extrabold tracking-[-0.03em] text-on-surface sm:text-[2.75rem] sm:leading-[1.05]"
            >
              Paid out, on the ledger
            </h2>
            <p className="mt-3 font-body text-base leading-relaxed text-on-surface-variant sm:text-lg">
              Every USDC payment sent from Centient&apos;s payout account on Stellar testnet, newest first. Test USDC
              has no cash value. Open any stub to see its transaction.
            </p>
          </div>
          <div className="flex items-center gap-5">
            {accountUrl && (
              <a
                href={accountUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center gap-1 rounded-md font-label text-sm font-semibold text-primary underline-offset-2 hover:underline ${FOCUS}`}
              >
                Payout account
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  open_in_new
                </span>
                <span className="sr-only"> on stellar.expert (opens in a new tab)</span>
              </a>
            )}
          </div>
        </div>

        <div aria-live="polite" aria-busy={feed.status === "loading"} className="mt-10">
          {feed.status === "loading" && (
            <ul className="-mx-5 flex gap-4 overflow-hidden px-5 sm:-mx-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-4 lg:px-0">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="h-[12.5rem] w-[15.5rem] shrink-0 rounded-sm bg-surface-container-high motion-safe:animate-pulse lg:w-auto" />
              ))}
            </ul>
          )}

          {feed.status === "ready" && feed.data.payouts.length > 0 && (
            <ol className="-mx-5 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-5 px-5 pb-4 pt-2 [scrollbar-width:thin] sm:-mx-8 sm:scroll-px-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0 lg:pb-0">
              {feed.data.payouts.map((p) => (
                <Stub key={p.id} payout={p} fresh={feed.fresh.has(p.id)} now={now} />
              ))}
            </ol>
          )}

          {feed.status === "ready" && feed.data.payouts.length === 0 && (
            <div className="rounded-2xl border border-dashed border-outline-variant px-6 py-10 text-center">
              <p className="font-headline text-lg font-bold text-on-surface">No payouts on this network yet</p>
              <p className="mx-auto mt-2 max-w-[40ch] font-body text-sm leading-relaxed text-on-surface-variant">
                When a labeler&apos;s answer is accepted, its payment shows up here within a minute.
              </p>
            </div>
          )}

          {feed.status === "error" && (
            <div className="rounded-2xl border border-dashed border-outline-variant px-6 py-10 text-center">
              <p className="font-headline text-lg font-bold text-on-surface">Couldn&apos;t reach the Stellar ledger</p>
              <p className="mx-auto mt-2 max-w-[40ch] font-body text-sm leading-relaxed text-on-surface-variant">
                Payouts are still recorded on-chain. This list tries again every 30 seconds while it&apos;s on
                screen.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
