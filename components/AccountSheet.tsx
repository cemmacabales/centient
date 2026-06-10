"use client";

import { useEffect, useState } from "react";
import { truncateAddress } from "@/lib/wallet";

interface AccountSheetProps {
  open: boolean;
  onClose: () => void;
  walletAddress: string;
  totalEarned: string;
  rewardSymbol: string;
  submissionCount: number;
  explorerUrl: string;
}

interface Submission {
  id: string;
  taskId: string;
  taskPrompt: string;
  choice: string;
  isGoldCheck: boolean;
  goldPassed: boolean | null;
  earnedDisplay: string;
  payoutStatus: string;
  payoutTxHash: string | null;
  submittedAt: string;
}

function PayoutChip({ status }: { status: string }) {
  const cls =
    status === "sent" || status === "confirmed"
      ? "bg-secondary-container text-on-secondary-container"
      : status === "failed"
        ? "bg-error-container text-on-error-container"
        : status === "pending"
          ? "bg-yellow-100 text-yellow-800"
          : "bg-surface-container-high text-on-surface-variant";
  return (
    <span className={`rounded-full px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
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
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setLoadingHistory(true);
    setHistoryError(false);
    fetch("/api/me/submissions?page=1")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setSubmissions(data.submissions ?? []))
      .catch(() => setHistoryError(true))
      .finally(() => setLoadingHistory(false));
  }, [open]);

  if (!open) return null;

  const truncated = truncateAddress(walletAddress);

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
      <div className="relative w-full max-w-lg rounded-t-3xl bg-surface-container-lowest p-6 pb-10 shadow-[0_-12px_40px_rgba(25,28,30,0.06)] max-h-[85vh] overflow-y-auto">
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
          className="mb-6 block w-full rounded-xl bg-surface-container-high py-3 text-center font-label text-sm font-semibold text-primary transition-colors hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          View on explorer
        </a>

        <div>
          <h3 className="mb-3 font-label text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
            Recent submissions
          </h3>
          {loadingHistory ? (
            <p className="py-4 text-center font-body text-xs text-on-surface-variant">Loading…</p>
          ) : historyError ? (
            <p className="py-4 text-center font-body text-xs text-on-surface-variant">
              Couldn&apos;t load history.
            </p>
          ) : submissions.length === 0 ? (
            <p className="py-4 text-center font-body text-xs text-on-surface-variant">
              No submissions yet.
            </p>
          ) : (
            <ul className="divide-y divide-outline-variant/20">
              {submissions.map((s) => (
                <li key={s.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <PayoutChip status={s.payoutStatus} />
                      {s.isGoldCheck && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-amber-800">
                          gold · {s.goldPassed ? "pass" : "fail"}
                        </span>
                      )}
                    </div>
                    <span className="font-label text-[10px] text-on-surface-variant">
                      {new Date(s.submittedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                      {" · "}chose <strong>{s.choice}</strong>
                      {" · "}+{s.earnedDisplay} {rewardSymbol}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 font-body text-xs text-on-surface-variant">
                    {s.taskPrompt}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
