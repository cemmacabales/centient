"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

/**
 * The owl's poses, in loop order. They follow one task: hello, reading the
 * prompt, weighing the two responses, the reason clicking, the payout. Each is
 * cut out of its background and aligned on the feet, so a swap reads as the
 * owl changing pose rather than jumping.
 */
const POSES = [
  "/mascot/owl-wave.webp",
  "/mascot/owl-laptop.webp",
  "/mascot/owl-think.webp",
  "/mascot/owl-idea.webp",
  "/mascot/owl-chart.webp",
];

/** Long enough to take in each pose; at one second the loop felt rushed. */
const POSE_MS = 2500;

/**
 * The owl, large, set in rings that echo its own eyes, cycling through its
 * poses, with the two moments of a task it stands for: a response chosen, and
 * the payout that follows.
 */
export default function LandingMascot() {
  const [pose, setPose] = useState(0);

  useEffect(() => {
    // Changing pose is motion: hold the first pose for anyone who asks for less.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setPose((p) => (p + 1) % POSES.length), POSE_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[400px] sm:max-w-[480px] lg:max-w-[600px]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-[2%] rounded-full border border-dashed border-primary/25 motion-safe:animate-[spin_90s_linear_infinite]" />
        <div className="absolute inset-[11%] rounded-full border border-outline-variant/60" />
        <div className="absolute inset-[21%] rounded-full border border-outline-variant/50" />
        <div className="absolute inset-[31%] rounded-full bg-primary-container/15" />
      </div>

      {/* The owl fills ~80% of its canvas, so the images overhang the rings to read large. */}
      <div
        role="img"
        aria-label="Centient's owl mascot"
        className="absolute -inset-[8%] motion-safe:animate-[centient-float_7s_ease-in-out_infinite]"
      >
        {POSES.map((src, i) => (
          <Image
            key={src}
            src={src}
            alt=""
            width={1024}
            height={1024}
            preload={i === 0}
            loading={i === 0 ? undefined : "eager"}
            sizes="(min-width: 1024px) 600px, (min-width: 640px) 480px, 90vw"
            // The swap itself is instant, so two poses never overlap; the new one springs in.
            className={`absolute inset-0 h-full w-full select-none drop-shadow-[0_24px_40px_rgba(25,28,30,0.12)] ${
              i === pose
                ? "scale-100 opacity-100 motion-safe:transition-[scale] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                : "scale-[0.96] opacity-0"
            }`}
          />
        ))}
      </div>

      <div
        aria-hidden="true"
        className="absolute right-0 top-[9%] flex items-center gap-2 rounded-xl bg-surface-container-lowest px-3 py-2 shadow-[0_8px_24px_rgba(25,28,30,0.08)] motion-safe:animate-[centient-rise_600ms_ease-out_400ms_both] sm:px-4 sm:py-2.5"
      >
        <span className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Response B
        </span>
        <span className="flex items-center gap-0.5 rounded-full bg-primary px-2 py-0.5 font-label text-xs font-bold text-on-primary">
          <span className="material-symbols-outlined text-[14px]">check</span>
          Chosen
        </span>
      </div>

      <div
        aria-hidden="true"
        className="absolute bottom-[12%] left-0 flex items-center gap-2 rounded-xl bg-surface-container-lowest px-3 py-2 shadow-[0_8px_24px_rgba(25,28,30,0.08)] motion-safe:animate-[centient-rise_600ms_ease-out_1000ms_both] sm:px-4 sm:py-2.5"
      >
        <span
          className="material-symbols-outlined text-[20px] text-secondary"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          monetization_on
        </span>
        <span className="font-headline text-base font-extrabold tracking-tight text-secondary sm:text-lg">
          +{REWARD_AMOUNT} {REWARD_TOKEN_SYMBOL}
        </span>
        <span className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Paid
        </span>
      </div>
    </div>
  );
}
