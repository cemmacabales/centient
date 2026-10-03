"use client";

import { useEffect, useRef, useState } from "react";
import { FEATURED_SAMPLE as SAMPLE } from "./LandingPhone";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

type Tone = "ink" | "money" | "confirmed";

interface Row {
  label: string;
  value: string;
  tone?: Tone;
}

interface Line {
  icon: string;
  title: string;
  body: string;
  /** The receipt fields this step fills in, for the hero's sample answer. */
  rows: Row[];
  money?: boolean;
}

const CHOSEN = SAMPLE.chosen ? "B" : "A";

/** One answer, in order: the steps are a real sequence, so they are numbered. */
const LINES: Line[] = [
  {
    icon: "chat",
    title: "Read the prompt",
    body: "Each task shows a question someone asked an AI, and two responses it gave.",
    rows: [{ label: "Prompt", value: SAMPLE.prompt }],
  },
  {
    icon: "rule",
    title: "Pick the better response",
    body: "Choose response A or B, then write a short reason saying why it's better.",
    rows: [
      { label: "Chose", value: `Response ${CHOSEN}` },
      { label: "Reason", value: SAMPLE.reason },
    ],
  },
  {
    icon: "payments",
    title: "Get paid",
    body: `Each approved answer pays the reward shown on its task, in ${REWARD_TOKEN_SYMBOL}, straight to the wallet you signed in with.`,
    rows: [{ label: "Paid", value: `${REWARD_AMOUNT} ${REWARD_TOKEN_SYMBOL}`, tone: "money" }],
    money: true,
  },
  {
    icon: "key",
    title: "Two keys sign it",
    body: "Every payout needs two of three keys to sign before it leaves Centient's payout account.",
    rows: [{ label: "Signatures", value: "2 of 3" }],
  },
  {
    icon: "travel_explore",
    title: "Check it on the ledger",
    body: "Each payment is a public Stellar transaction. Your account shows its status: pending, sent or confirmed.",
    rows: [
      { label: "Tx", value: SAMPLE.tx },
      { label: "Status", value: "Confirmed", tone: "confirmed" },
    ],
  },
];

const VALUE_TONE: Record<Tone, string> = {
  ink: "text-on-surface",
  money: "font-headline font-bold text-secondary",
  confirmed: "font-semibold text-primary",
};

/**
 * What happens to one answer: the hero's sample, itemized. Each line lights up
 * in ink as it reaches the middle of the screen and its receipt fields print
 * in, while the rail beside the list fills to that line. Green is kept for the
 * one confirmation at the end.
 */
export default function AnswerJourney() {
  const listRef = useRef<HTMLOListElement>(null);
  // Everything shows as reached until the observer says otherwise, so a page
  // without scripts, or with reduced motion, reads as a finished receipt.
  const [reached, setReached] = useState(LINES.length - 1);
  const [tracking, setTracking] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>("[data-line]"));
    const measure = () => {
      const middle = window.innerHeight * 0.55;
      let last = -1;
      items.forEach((item, i) => {
        if (item.getBoundingClientRect().top < middle) last = i;
      });
      setReached(last);
    };
    setTracking(true);
    measure();
    // Fires as any line crosses the middle band; the handler reads where each one is.
    const io = new IntersectionObserver(measure, {
      rootMargin: "-45% 0px -45% 0px",
      threshold: [0, 1],
    });
    items.forEach((item) => io.observe(item));
    return () => io.disconnect();
  }, []);

  const fill = Math.max(0, reached) / (LINES.length - 1);

  return (
    <section
      id="how-it-works"
      aria-labelledby="how-heading"
      className="mx-auto grid max-w-6xl scroll-mt-20 grid-cols-[minmax(0,1fr)] gap-12 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:gap-20"
    >
      <div className="lg:sticky lg:top-32 lg:self-start">
        <h2
          id="how-heading"
          className="font-headline text-3xl font-extrabold tracking-[-0.03em] text-on-surface sm:text-[2.75rem] sm:leading-[1.05]"
        >
          What happens to one answer
        </h2>
        <p className="mt-4 max-w-[34ch] font-body text-base leading-relaxed text-on-surface-variant sm:text-lg">
          Every task follows the same path, from the prompt to your wallet.
        </p>
      </div>

      <ol ref={listRef} className="relative">
        {/* The rail, filled to the line the reader has reached. */}
        <div aria-hidden="true" className="absolute bottom-6 left-5 top-6 w-0.5 -translate-x-1/2 rounded-full bg-outline-variant/50">
          <div
            className="h-full w-full origin-top rounded-full bg-on-surface transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ transform: `scaleY(${fill})` }}
          />
        </div>

        {LINES.map((line, i) => {
          const on = i <= reached;
          return (
            <li key={line.title} data-line className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-5 pb-14 last:pb-0 sm:gap-7">
              <span
                aria-hidden="true"
                className={`relative z-10 grid h-10 w-10 place-items-center rounded-full font-headline text-sm font-bold tabular-nums transition-[background-color,color,box-shadow] duration-500 ${
                  on
                    ? "bg-on-surface text-surface shadow-[0_8px_20px_rgba(25,28,30,0.18)]"
                    : "bg-surface-container-lowest text-outline ring-1 ring-outline-variant"
                }`}
              >
                {i + 1}
              </span>
              <div
                className={`pt-1 transition-opacity duration-500 ${on || !tracking ? "opacity-100" : "opacity-40"}`}
              >
                <h3 className="flex items-center gap-2.5 font-headline text-xl font-bold text-on-surface sm:text-2xl">
                  <span
                    className={`material-symbols-outlined text-[26px] ${line.money ? "text-secondary" : "text-on-surface-variant"}`}
                    aria-hidden="true"
                  >
                    {line.icon}
                  </span>
                  {line.title}
                </h3>
                <p className="mt-2 max-w-[46ch] font-body text-base leading-relaxed text-on-surface-variant">
                  {line.body}
                </p>
                <div
                  className={`mt-4 flex max-w-[30rem] flex-col gap-1.5 rounded-lg bg-surface-container-lowest px-3.5 py-2.5 font-label text-sm shadow-[0_4px_12px_rgba(25,28,30,0.04)] ${
                    on && tracking ? "motion-safe:animate-[landing-print_600ms_steps(14)_both]" : ""
                  } ${on || !tracking ? "" : "invisible"}`}
                >
                  {line.rows.map((row) => (
                    <p key={row.label} className="flex min-w-0 items-start">
                      <span className="shrink-0 text-on-surface-variant">{row.label}</span>
                      <span className="mx-2 mt-[0.9em] h-px min-w-6 flex-1 border-b border-dotted border-outline-variant" />
                      {/* A long value wraps under itself rather than being cut off. */}
                      <span className={`min-w-0 ${VALUE_TONE[row.tone ?? "ink"]} ${row.label === "Tx" ? "font-mono text-xs leading-5" : ""}`}>
                        {row.tone === "confirmed" && (
                          <span
                            className="material-symbols-outlined mr-1 align-[-3px] text-[15px]"
                            style={{ fontVariationSettings: "'FILL' 1" }}
                            aria-hidden="true"
                          >
                            verified
                          </span>
                        )}
                        {row.value}
                      </span>
                    </p>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
