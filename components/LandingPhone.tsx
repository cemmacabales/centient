"use client";

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import Image from "next/image";
import LandingMascot, { type OwlPose } from "./LandingMascot";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

interface SampleTask {
  prompt: string;
  responses: [string, string];
  chosen: 0 | 1;
  reason: string;
  /** Made up: the caption says this task is a sample. */
  tx: string;
}

/** Tasks from the seeded pool (prisma/seed.ts). */
const SAMPLES: SampleTask[] = [
  {
    prompt: "What is the capital of Australia?",
    responses: [
      "Sydney.",
      "Canberra. It's a common misconception that it's Sydney, which is the largest city but not the capital.",
    ],
    chosen: 1,
    reason: "A is wrong. B names the real capital and explains the mix-up.",
    tx: "3f9a…c21e",
  },
  {
    prompt: "What year did World War II end?",
    responses: [
      "1945.",
      "World War II ended in 1945 with the surrender of Japan in September, following Germany's surrender in May.",
    ],
    chosen: 1,
    reason: "Both say 1945, but B also explains how the war ended.",
    tx: "b71d…04af",
  },
  {
    prompt: "What is the largest planet in our solar system?",
    responses: [
      "Jupiter. It's so massive that it's more than twice the mass of all the other planets combined.",
      "The largest planet is Jupiter.",
    ],
    chosen: 0,
    reason: "Both are right, but A adds a useful fact about its size.",
    tx: "e2c8…9b17",
  },
];

/** The sample the phone plays first; the journey section follows the same answer. */
export const FEATURED_SAMPLE = SAMPLES[0];

/** The labeler's wallet in the app header, shortened the way WalletChip does. */
const WALLET = "GBX7KQ…Q4NM";

/** The phone screen is laid out at a real phone's CSS size, then scaled to the frame. */
const SCREEN_W = 360;
const SCREEN_H = 760;

/** One task, in the order it plays. */
const S = {
  Top: 0,
  Read: 1,
  Tap: 2,
  Chosen: 3,
  Reason: 4,
  Typing: 5,
  Send: 6,
  Sending: 7,
  Paid: 8,
  Next: 9,
} as const;

/** How long each stage holds before the next. Typing holds for its keystrokes instead. */
const HOLD_MS: Record<number, number> = {
  [S.Top]: 1300,
  [S.Read]: 1500,
  [S.Tap]: 520,
  [S.Chosen]: 700,
  [S.Reason]: 850,
  [S.Send]: 520,
  [S.Sending]: 850,
  [S.Paid]: 3200,
  [S.Next]: 520,
};
const TYPE_MS = 32;

/** The real app only enables Submit once the reason reaches this length. */
const MIN_REASON = 10;

function poseFor(stage: number): OwlPose {
  if (stage === S.Top) return "wave";
  if (stage === S.Read) return "think";
  if (stage <= S.Chosen) return "idea";
  if (stage < S.Paid) return "laptop";
  return "chart";
}

/** "0.05" stays "0.05"; "0.1" becomes "0.10". */
function cents(amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

interface Playback {
  /** Tasks finished so far; it picks the sample and the running total. */
  round: number;
  stage: number;
  typed: number;
}

type Action = { type: "next" } | { type: "type" };

function reducer(state: Playback, action: Action): Playback {
  if (action.type === "type") return { ...state, typed: state.typed + 1 };
  if (state.stage === S.Next) return { round: state.round + 1, stage: S.Top, typed: 0 };
  return { ...state, stage: state.stage + 1 };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A Material Symbol at a set size. The size is inline because the icon font's
 * own stylesheet sets 24px outside any cascade layer, which beats a Tailwind
 * `text-[…]` utility.
 */
function Icon({ name, size, className = "", filled = false }: { name: string; size: number; className?: string; filled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`material-symbols-outlined ${className}`}
      style={{ fontSize: size, ...(filled ? { fontVariationSettings: "'FILL' 1" } : {}) }}
    >
      {name}
    </span>
  );
}

/** A fingertip landing on a control: it presses in, then lifts and fades. */
function Touch() {
  return (
    <span className="pointer-events-none absolute left-1/2 top-1/2 -ml-6 -mt-6 h-12 w-12 rounded-full bg-on-surface/25 ring-2 ring-surface-container-lowest/70 motion-safe:animate-[landing-tap_520ms_cubic-bezier(0.16,1,0.3,1)_both]" />
  );
}

const CARD = "rounded-2xl bg-surface-container-lowest p-6 shadow-[0_8px_24px_rgba(25,28,30,0.06)]";
const MICRO = "font-label text-xs font-bold uppercase tracking-[0.2em] text-outline";
const POP = "motion-safe:animate-[landing-pop_320ms_cubic-bezier(0.16,1,0.3,1)_both]";

/**
 * The landing's signature: a phone running the real task screen, playing one
 * sample task end to end with no input from the visitor. The screen scrolls
 * through the prompt and both responses, a fingertip picks the better one, the
 * reason types itself, Submit & Get Paid is tapped, and the success screen says
 * the reward is on its way. Next Task brings up the following sample, and the
 * earnings in the header have gone up by one reward. The owl beside the phone
 * changes pose with each stage.
 *
 * The screen is a miniature of TaskCard and the success screen in app/page.tsx,
 * laid out at 360 by 760 CSS pixels and scaled to fit the frame, so it keeps the
 * app's real proportions at every size.
 *
 * It only runs while on screen and in a visible tab. With reduced motion it
 * shows the answered task, ready to submit, and stays still.
 */
export default function LandingPhone() {
  const captionId = useId();
  const [reduced] = useState(prefersReducedMotion);
  const [active, setActive] = useState(false);
  const [{ round, stage, typed }, dispatch] = useReducer(
    reducer,
    undefined,
    (): Playback =>
      prefersReducedMotion() ? { round: 0, stage: S.Typing, typed: Infinity } : { round: 0, stage: S.Top, typed: 0 },
  );

  const figureRef = useRef<HTMLElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  /** The last scroll position and the timer that hides the indicator; both outlive a stage change. */
  const lastY = useRef(-1);
  const thumbFade = useRef(0);

  const task = SAMPLES[round % SAMPLES.length];
  const reward = cents(REWARD_AMOUNT);
  const earned = (round * Number(REWARD_AMOUNT)).toFixed(2);

  // Fit the 360px-wide screen to whatever width the frame has.
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const fit = () => screen.style.setProperty("--s", String(screen.clientWidth / SCREEN_W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(screen);
    return () => ro.disconnect();
  }, []);

  // Play only while the phone is on screen and the tab is visible.
  useEffect(() => {
    const figure = figureRef.current;
    if (!figure || reduced) return;
    let inView = false;
    const update = () => setActive(inView && document.visibilityState === "visible");
    const io = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    io.observe(figure);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [reduced]);

  // Advance through the stages.
  useEffect(() => {
    if (reduced || !active) return;
    if (stage === S.Typing) {
      if (typed < task.reason.length) {
        const id = window.setTimeout(() => dispatch({ type: "type" }), TYPE_MS);
        return () => window.clearTimeout(id);
      }
      const id = window.setTimeout(() => dispatch({ type: "next" }), 450);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => dispatch({ type: "next" }), HOLD_MS[stage]);
    return () => window.clearTimeout(id);
  }, [reduced, active, stage, typed, task.reason.length]);

  // Scroll the screen: the task opens at the top, with the prompt and both
  // responses in view; once one is chosen it scrolls down to the reason above
  // the submit bar. A new task starts at the top again, with no scroll from
  // where the last one left (the success screen covers the jump).
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !content || !thumb) return;
    const place = () => {
      const vh = viewport.clientHeight;
      const total = content.offsetHeight;
      const max = Math.max(0, total - vh);
      const y = stage >= S.Reason ? max : 0;
      content.style.transform = `translateY(${-y}px)`;
      thumb.style.height = `${(vh / total) * vh}px`;
      thumb.style.transform = `translateY(${(y / total) * vh}px)`;
      // The scroll indicator shows while the screen moves, as a phone's does.
      if (lastY.current >= 0 && Math.abs(y - lastY.current) > 1 && !content.hasAttribute("data-instant")) {
        thumb.setAttribute("data-on", "");
        window.clearTimeout(thumbFade.current);
        thumbFade.current = window.setTimeout(() => thumb.removeAttribute("data-on"), 1000);
      }
      lastY.current = y;
    };
    let raf = 0;
    if (stage === S.Top) {
      content.setAttribute("data-instant", "");
      thumb.setAttribute("data-instant", "");
      place();
      void content.offsetHeight;
      raf = requestAnimationFrame(() => {
        content.removeAttribute("data-instant");
        thumb.removeAttribute("data-instant");
      });
    } else {
      place();
    }
    const ro = new ResizeObserver(place);
    ro.observe(content);
    ro.observe(viewport);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [stage, round]);

  // A light tilt toward the pointer, on devices that have one.
  useEffect(() => {
    const figure = figureRef.current;
    const tilt = tiltRef.current;
    if (!figure || !tilt || reduced || !window.matchMedia("(pointer: fine)").matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = figure.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        tilt.style.transform = `rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 9).toFixed(2)}deg)`;
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(raf);
      tilt.style.transform = "";
    };
    figure.addEventListener("pointermove", onMove);
    figure.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      figure.removeEventListener("pointermove", onMove);
      figure.removeEventListener("pointerleave", onLeave);
    };
  }, [reduced]);

  const chosen = stage >= S.Chosen;
  const shownReason = stage < S.Typing ? "" : task.reason.slice(0, typed);
  const typing = stage === S.Typing && typed < task.reason.length;
  const canSubmit = shownReason.length >= MIN_REASON;
  const paid = stage >= S.Paid;
  const first = SAMPLES[0];

  return (
    <figure ref={figureRef} aria-labelledby={captionId} className="relative mx-auto w-full max-w-[34rem]">
      <p className="sr-only">
        Sample task on a phone: {first.prompt} The labeler picks response {first.chosen ? "B" : "A"}, explains why
        ({first.reason}), and submits. The app confirms {reward} {REWARD_TOKEN_SYMBOL} is on its way to their wallet.
      </p>

      <div aria-hidden="true" className="flex justify-center [perspective:1600px]">
        {/* From sm up, nudged right so the owl and the phone, together, sit
            centered. A phone column has no room for that, so there the phone
            centers on its own and the owl tucks into the gutter beside it. */}
        <div className="relative sm:translate-x-12 lg:translate-x-14">
          <div ref={tiltRef} className="transition-transform duration-500 ease-out">
            {/* The handset: a dark frame with side keys, and the screen inside it. */}
            <div className="relative w-[16.5rem] rounded-[2.6rem] bg-inverse-surface p-[0.55rem] shadow-[0_32px_64px_-20px_rgba(25,28,30,0.38),0_14px_28px_rgba(25,28,30,0.10),inset_0_0_0_1.5px_rgba(255,255,255,0.10)] sm:w-[18rem] lg:w-[18.5rem] lg:rounded-[2.9rem] xl:w-[19.5rem]">
              <span className="absolute -left-[3px] top-[18%] h-[5%] w-[3px] rounded-l-sm bg-inverse-surface" />
              <span className="absolute -left-[3px] top-[26%] h-[8%] w-[3px] rounded-l-sm bg-inverse-surface" />
              <span className="absolute -left-[3px] top-[36%] h-[8%] w-[3px] rounded-l-sm bg-inverse-surface" />
              <span className="absolute -right-[3px] top-[28%] h-[12%] w-[3px] rounded-r-sm bg-inverse-surface" />

              <div
                ref={screenRef}
                style={{ aspectRatio: `${SCREEN_W} / ${SCREEN_H}` }}
                className="relative overflow-hidden rounded-[2.05rem] bg-surface lg:rounded-[2.35rem]"
              >
                <div
                  className="absolute left-0 top-0 origin-top-left"
                  style={{ width: SCREEN_W, height: SCREEN_H, transform: "scale(var(--s, 0.7))" }}
                >
                  {/* Status bar and the camera island. */}
                  <div className="flex h-[50px] items-center justify-between px-8 pt-1.5 font-label text-[15px] font-semibold text-on-surface">
                    <span className="tabular-nums">9:41</span>
                    <span className="flex items-center gap-1">
                      <Icon name="signal_cellular_alt" size={17} />
                      <Icon name="wifi" size={17} />
                      <Icon name="battery_full" size={19} className="rotate-90" />
                    </span>
                  </div>
                  <div className="absolute left-1/2 top-[11px] z-50 h-[30px] w-[100px] -translate-x-1/2 rounded-full bg-on-surface" />

                  <div className="absolute inset-x-0 bottom-0 top-[50px]">
                    {/* The task screen's sticky header (app/page.tsx). */}
                    <header className="relative z-20 flex h-16 items-center justify-between bg-surface-container-low px-4">
                      <div className="flex items-center gap-2">
                        <Image src="/logo.png" alt="" width={30} height={30} loading="eager" className="select-none" />
                        <span className="font-headline text-xl font-extrabold tracking-tighter text-primary">Centient</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 rounded-full bg-surface-container-lowest px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
                          <Icon name="account_balance_wallet" size={16} className="text-outline" />
                          <span className="font-mono text-xs font-medium text-on-surface-variant">{WALLET}</span>
                        </span>
                        <span
                          key={round}
                          className={`rounded-full bg-secondary-fixed/20 px-3 py-1 font-label text-sm font-semibold tabular-nums text-secondary ${
                            round > 0 ? POP : ""
                          }`}
                        >
                          ${earned}
                        </span>
                      </div>
                    </header>

                    {/* The scrolling body: a miniature of TaskCard. */}
                    <div ref={viewportRef} className="absolute inset-x-0 bottom-0 top-16 overflow-hidden">
                      <div ref={contentRef} data-instant="" className="phone-scroll relative flex flex-col gap-4 px-4 pt-6">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Icon name="dataset" size={20} className="text-primary" />
                            <span className={MICRO}>Label Task</span>
                          </div>
                          <span className="flex items-center gap-1.5 rounded-xl bg-surface-container-lowest px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
                            <Icon name="monetization_on" size={14} filled className="text-secondary" />
                            <span className="font-headline text-sm font-bold text-secondary">
                              {reward} {REWARD_TOKEN_SYMBOL}
                            </span>
                          </span>
                        </div>

                        <section className={CARD}>
                          <div className="mb-3 flex items-center gap-2">
                            <Icon name="chat" size={20} className="text-primary" />
                            <span className={MICRO}>The Prompt</span>
                          </div>
                          <p className="font-body text-base leading-relaxed text-on-surface">{task.prompt}</p>
                        </section>

                        <div className="flex flex-col gap-3">
                          {task.responses.map((text, i) => {
                            const side = i ? "B" : "A";
                            const selected = chosen && i === task.chosen;
                            const pressing = stage === S.Tap && i === task.chosen;
                            return (
                              <div
                                key={`${round}-${side}`}
                                className={`${CARD} transition-[scale,box-shadow] duration-200 ${
                                  selected ? "scale-[1.01] ring-2 ring-primary" : ""
                                }`}
                              >
                                <div className="mb-3 flex h-5 items-center justify-between">
                                  <span className={MICRO}>Response {side}</span>
                                  {selected && (
                                    <span
                                      className={`flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 font-label text-xs font-bold text-on-primary ${POP}`}
                                    >
                                      <Icon name="check" size={14} />
                                      Selected
                                    </span>
                                  )}
                                </div>
                                <p className="font-body text-sm leading-relaxed text-on-surface">{text}</p>
                                <span
                                  className={`relative mt-4 block w-full rounded-xl px-4 py-3 text-center font-label text-sm font-semibold transition-[background-color,color,scale] duration-200 ${
                                    selected ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant"
                                  } ${pressing ? "scale-[0.97]" : ""}`}
                                >
                                  {side} is better
                                  {pressing && <Touch />}
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {chosen && (
                          <section className={CARD}>
                            <p className="mb-2 font-headline text-sm font-bold text-on-surface">
                              Why? <span className="font-body text-xs font-normal text-outline">(min 10 characters)</span>
                            </p>
                            <p className="min-h-[5.25rem] rounded-lg bg-surface-container-highest px-4 py-3 font-body text-sm leading-5 text-on-surface">
                              {shownReason}
                              {typing && (
                                <span className="ml-px inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-primary motion-safe:animate-[landing-caret_900ms_steps(1)_infinite]" />
                              )}
                              {!shownReason && (
                                <span className="text-on-surface-variant/50">
                                  Explain your reasoning for selecting the better response...
                                </span>
                              )}
                            </p>
                          </section>
                        )}

                        {/* Room for the sticky submit bar, as in the app. */}
                        <div className={chosen ? "h-[7.5rem] shrink-0" : "h-2 shrink-0"} />
                      </div>

                      {/* The scroll indicator. */}
                      <div
                        ref={thumbRef}
                        data-instant=""
                        className="phone-thumb absolute right-[3px] top-0 w-[3px] rounded-full bg-on-surface/35"
                      />

                      {/* The sticky submit bar slides up once a response is chosen. */}
                      <div
                        className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-surface via-surface/95 to-transparent px-4 pb-[34px] pt-6 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                          stage === S.Top ? "" : "transition-transform duration-500"
                        } ${chosen ? "translate-y-0" : "translate-y-full"}`}
                      >
                        <span
                          className={`relative flex h-16 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-on-primary shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-[opacity,scale] duration-200 ${
                            canSubmit ? "" : "opacity-50"
                          } ${stage === S.Send ? "scale-[0.97]" : ""}`}
                        >
                          {stage === S.Sending || paid ? (
                            <span className="flex gap-1">
                              {[0, 1, 2].map((d) => (
                                <span
                                  key={d}
                                  className="h-2 w-2 rounded-full bg-on-primary motion-safe:animate-pulse"
                                  style={{ animationDelay: `${d * 0.15}s` }}
                                />
                              ))}
                            </span>
                          ) : (
                            <>
                              Submit &amp; Get Paid
                              <Icon name="arrow_forward" size={22} />
                            </>
                          )}
                          {stage === S.Send && <Touch />}
                        </span>
                      </div>
                    </div>

                    {/* The success screen (app/page.tsx), over the task it confirms. */}
                    <div
                      className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-surface px-6 transition-opacity duration-300 ${
                        paid ? "opacity-100" : "pointer-events-none opacity-0"
                      }`}
                    >
                      {/* Mounted throughout, so it fades out whole instead of emptying first. */}
                      <span
                        key={round}
                        className={`flex h-32 w-32 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container shadow-[0_12px_40px_-12px_rgba(0,109,61,0.5)] ${
                          paid ? POP : ""
                        }`}
                      >
                        <Icon name="check" size={64} filled className="text-on-primary" />
                      </span>
                      <p className="font-headline text-2xl font-bold text-on-surface">
                        +{reward} {REWARD_TOKEN_SYMBOL} on its way
                      </p>
                      <p className="text-center font-body text-sm text-on-surface-variant">
                        Your contribution helps improve AI. Your reward is being sent to your wallet — follow it in
                        your account.
                      </p>
                      <span
                        className={`relative flex h-16 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-on-primary shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-[scale] duration-200 ${
                          stage === S.Next ? "scale-[0.97]" : ""
                        }`}
                      >
                        Next Task
                        <Icon name="arrow_forward" size={22} />
                        {stage === S.Next && <Touch />}
                      </span>
                    </div>
                  </div>

                  {/* The home indicator. */}
                  <div className="absolute bottom-2 left-1/2 z-50 h-[5px] w-[124px] -translate-x-1/2 rounded-full bg-on-surface/85" />
                </div>
              </div>
            </div>
          </div>

          {/* The owl stands at the phone's lower left, in front of the frame. */}
          <div className="absolute -bottom-3 right-full z-10 -mr-10 w-20 sm:-mr-11 sm:w-36 lg:-mr-12 lg:w-40">
            <LandingMascot
              pose={poseFor(stage)}
              decorative
              sizes="(min-width: 1024px) 160px, (min-width: 640px) 144px, 80px"
              className="w-full"
            />
          </div>
        </div>
      </div>

      <figcaption
        id={captionId}
        className="mx-auto mt-6 flex w-fit max-w-[16.5rem] items-start sm:max-w-none gap-1.5 font-body text-[13px] leading-snug text-on-surface-variant"
      >
        <Icon name="replay" size={16} className="mt-px text-outline" />
        Sample task on Stellar testnet, replayed automatically.
      </figcaption>
    </figure>
  );
}
