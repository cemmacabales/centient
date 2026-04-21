"use client";

import { useEffect } from "react";

interface AccountSheetProps {
  open: boolean;
  onClose: () => void;
  walletAddress: string;
  totalEarned: string;
  rewardSymbol: string;
  submissionCount: number;
  explorerUrl: string;
}

export default function AccountSheet({
  open,
  onClose,
  walletAddress,
  totalEarned,
  rewardSymbol,
  submissionCount,
  explorerUrl,
}: AccountSheetProps) {
  useEffect(() => {
    if (!open) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const truncated = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : "—";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-sheet-title"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute inset-0 bg-on-surface/30"
      />
      <div className="relative w-full max-w-lg rounded-t-3xl bg-surface-container-lowest p-6 pb-10 shadow-[0_-12px_40px_rgba(25,28,30,0.06)]">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-outline-variant" />
        <h2
          id="account-sheet-title"
          className="mb-4 font-headline text-lg font-bold text-on-surface"
        >
          Account
        </h2>

        <div className="mb-6 flex items-center justify-between rounded-2xl bg-surface-container-low p-4">
          <span
            className="font-mono text-sm text-on-surface"
            aria-label="Wallet address"
          >
            {truncated}
          </span>
          <button
            type="button"
            onClick={() => {
              if (walletAddress) navigator.clipboard?.writeText(walletAddress);
            }}
            className="rounded-xl bg-surface-container-high px-3 py-1 text-xs font-label font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Copy
          </button>
        </div>

        <div className="mb-6 flex flex-col items-center gap-1">
          <span className="text-xs font-label font-bold uppercase tracking-widest text-outline">
            Total earned
          </span>
          <div className="flex items-baseline gap-1">
            <span className="font-headline text-4xl font-extrabold tracking-tighter text-on-surface">
              {totalEarned}
            </span>
            <span className="font-headline text-xl font-bold text-secondary">
              {rewardSymbol}
            </span>
          </div>
          <span className="font-body text-xs text-on-surface-variant">
            {submissionCount} submissions
          </span>
        </div>

        <a
          href={`${explorerUrl}/address/${walletAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-xl bg-surface-container-high py-3 text-center font-label text-sm font-semibold text-primary transition-colors hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          View on explorer
        </a>
      </div>
    </div>
  );
}
