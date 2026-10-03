"use client";

import Image from "next/image";

/**
 * The owl's poses. They follow one task: hello, reading the prompt, weighing
 * the two responses, the reason clicking, the payout. Each is cut out of its
 * background and aligned on the feet, so a swap reads as the owl changing pose
 * rather than jumping.
 */
const POSES = {
  wave: "/mascot/owl-wave.webp",
  laptop: "/mascot/owl-laptop.webp",
  think: "/mascot/owl-think.webp",
  idea: "/mascot/owl-idea.webp",
  chart: "/mascot/owl-chart.webp",
} as const;

export type OwlPose = keyof typeof POSES;

const ORDER = Object.keys(POSES) as OwlPose[];

interface LandingMascotProps {
  pose: OwlPose;
  /** Sizing and placement; the owl fills a square box. */
  className?: string;
  /** `next/image` sizes for the box. */
  sizes: string;
  /** Beside a receipt that already describes the task, the owl is decoration. */
  decorative?: boolean;
}

/**
 * The owl, in whichever pose its surroundings call for. Every pose is loaded up
 * front so a change never waits on the network; the swap itself is instant, so
 * two poses never overlap, and the new one settles in from slightly smaller.
 */
export default function LandingMascot({ pose, className = "", sizes, decorative = false }: LandingMascotProps) {
  return (
    <div
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Centient's owl mascot" })}
      className={`relative aspect-square ${className}`}
    >
      {ORDER.map((p) => (
        <Image
          key={p}
          src={POSES[p]}
          alt=""
          width={1024}
          height={1024}
          loading="eager"
          sizes={sizes}
          className={`absolute inset-0 h-full w-full select-none drop-shadow-[0_18px_28px_rgba(25,28,30,0.12)] ${
            p === pose
              ? "scale-100 opacity-100 motion-safe:transition-[scale] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
              : "scale-[0.92] opacity-0"
          }`}
        />
      ))}
    </div>
  );
}
