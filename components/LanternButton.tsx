"use client";

import type { ReactNode } from "react";

/**
 * The wallet button in Lantern's colours: its navy tile and the amber of its
 * flame, so a contributor who has Lantern recognises their wallet at a glance.
 *
 * Two shapes. With `href` it is a link — "Open in Lantern" on an Android phone
 * that has Lantern, handing this page to the app. Without it, a button — the
 * connect control when the page is already running inside Lantern.
 *
 * It arrives lit: the button rises in while a ring of warm light spreads off it
 * and fades, and the flame keeps a slow flicker after. All of it is CSS
 * (`.lantern-*` in globals.css), and under reduced motion it is simply there,
 * lit, with nothing moving.
 */
interface LanternButtonProps {
  children: ReactNode;
  /** Open this link instead of acting as a button. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}

const SHAPE =
  "lantern-button relative flex h-14 w-full items-center justify-center gap-3 rounded-full px-6 font-label text-lg font-bold text-[#fff4e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffb347] focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

function Flame() {
  return (
    <span className="lantern-flame relative h-8 w-8 shrink-0 overflow-hidden rounded-lg" aria-hidden="true">
      {/* Lantern's own app icon; decorative, the label names the wallet. */}
      <img src="/lantern/icon.png" alt="" width={32} height={32} className="h-full w-full" />
    </span>
  );
}

export default function LanternButton({ children, href, onClick, disabled, busy }: LanternButtonProps) {
  if (href) {
    return (
      <a href={href} className={SHAPE} data-lantern="open">
        <Flame />
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
      className={`${SHAPE} disabled:opacity-70`}
      data-lantern="connect"
    >
      <Flame />
      {children}
    </button>
  );
}
