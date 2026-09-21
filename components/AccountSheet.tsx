"use client";

import { useEffect, useState } from "react";
import { type ToastKind } from "@/components/Toast";
import { resetIdentity, track } from "@/lib/analytics";
import { truncateAddress } from "@/lib/wallet";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";
import { isValidStellarAddress } from "@/lib/stellar/signature";

// Withdrawal statuses that are still in flight — while any withdrawal is in one of
// these, the account sheet polls so the chip advances live. Terminal states
// (confirmed, failed, cancelled) stop the polling.
const ACTIVE_WITHDRAWAL_STATUSES = new Set([
  "pending",
  "queued",
  "processing",
  "sent",
]);

function formatTokenBalance(unitsStr: string): string {
  try {
    return unitsToUsdcDisplay(BigInt(unitsStr));
  } catch {
    return "0";
  }
}

interface AccountSheetProps {
  open: boolean;
  onClose: () => void;
  walletAddress: string;
  totalEarned: string;
  rewardSymbol: string;
  submissionCount: number;
  explorerUrl: string;
  country: string | null;
  gender: string | null;
  ageRange: string | null;
  showToast: (message: string, kind?: ToastKind) => void;
  onDemographicsDeleted: () => void;
  /** A withdrawal was refused because payout setup is unfinished: take the contributor there. */
  onPayoutSetupRequired?: () => void;
  /** The session cookie is gone: drop the app back to the logged-out screen. */
  onLoggedOut: () => void;
}

function formatDemographicField(value: string | null): string {
  if (!value) return "Not provided";
  return value;
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

interface Withdrawal {
  id: string;
  amountUnits: string;
  status: string;
  txHash: string | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

interface WithdrawalData {
  pendingBalanceUnits: string;
  thresholdUnits: string;
  /** #30: the account's bound wallet — the only address a withdrawal is paid to. */
  destinationAddress: string | null;
  canWithdraw: boolean;
  withdrawals: Withdrawal[];
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
  country,
  gender,
  ageRange,
  showToast,
  onDemographicsDeleted,
  onPayoutSetupRequired,
  onLoggedOut,
}: AccountSheetProps) {
  const [deleting, setDeleting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showDataSection, setShowDataSection] = useState(false);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [withdrawalData, setWithdrawalData] = useState<WithdrawalData | null>(null);
  const [loadingWithdrawal, setLoadingWithdrawal] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  useEffect(() => {
    if (!open) return;
    setLoadingWithdrawal(true);
    fetch("/api/me/withdraw")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setWithdrawalData(data))
      .catch(() => setWithdrawalData(null))
      .finally(() => setLoadingWithdrawal(false));
  }, [open]);

  // Live-poll while a withdrawal is still moving through the payout pipeline so the
  // status chip advances queued → processing → sent → confirmed without a reload.
  // Stops once every withdrawal has settled to a terminal state.
  useEffect(() => {
    if (!open || !withdrawalData) return;
    const hasActive = withdrawalData.withdrawals.some((w) =>
      ACTIVE_WITHDRAWAL_STATUSES.has(w.status),
    );
    if (!hasActive) return;
    const id = setInterval(() => {
      fetch("/api/me/withdraw")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data) => setWithdrawalData(data))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [open, withdrawalData]);

  if (!open) return null;

  const truncated = truncateAddress(walletAddress);
  const destination = withdrawalData?.destinationAddress ?? null;

  // Logging out in place: the sheet makes the call itself and hands control back
  // to the page, which swaps to the logged-out screen. The old form POST relied
  // on the route's 303 to navigate, which meant a full page load on success and
  // nothing at all on a response the browser would not follow.
  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        redirect: "manual",
      });
      // `redirect: "manual"` surfaces the 303 as an opaque response (type
      // "opaqueredirect", status 0); the Set-Cookie on it has already applied.
      if (res.type !== "opaqueredirect" && !res.ok) {
        throw new Error(`logout failed: ${res.status}`);
      }
      // The form used to reset PostHog on submit; the analytics identity has to
      // be dropped here for the same reason — the next person on this browser
      // starts anonymous.
      resetIdentity();
      onLoggedOut();
    } catch {
      showToast("Log out failed. Please try again.", "error");
      setLoggingOut(false);
    }
  };

  const submitWithdraw = async () => {
    setConfirming(false);
    setWithdrawing(true);
    try {
      // #30: no destination is sent. The server pays the account's bound wallet.
      const res = await fetch("/api/me/withdraw", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        track("withdrawal_initiated");
        showToast(`Withdrawal initiated: ${formatTokenBalance(data.amountUnits)} ${rewardSymbol}`, "success");
        const updated = await fetch("/api/me/withdraw")
          .then((r) => (r.ok ? r.json() : Promise.reject(r)))
          .catch(() => null);
        if (updated) setWithdrawalData(updated);
      } else {
        // Only the route's snake_case codes are sent, never its free-text message.
        const reason =
          typeof data.error === "string" && /^[a-z_]+$/.test(data.error) ? data.error : `http_${res.status}`;
        track("withdrawal_failed", { reason, http_status: res.status });
        showToast(data.message || data.error || "Withdrawal failed", "error");
        // Payout setup may have been left for later; this is where it is needed.
        if (res.status === 409 && data.error === "payout_setup_required") onPayoutSetupRequired?.();
      }
    } catch {
      // A dropped request, or a response that is not JSON (e.g. a gateway error page).
      track("withdrawal_failed", { reason: "network" });
      showToast("Withdrawal failed", "error");
    } finally {
      setWithdrawing(false);
    }
  };

  const handleWithdraw = () => {
    if (!withdrawalData?.canWithdraw || withdrawing || !destination) return;
    setConfirming(true);
  };

  const handleDeleteDemographics = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/me/demographics", { method: "DELETE" });
      if (res.ok) {
        track("demographics_deleted");
        // Clear the parent's cached demographics so reopening the sheet doesn't
        // show the just-deleted values from stale state.
        onDemographicsDeleted();
        showToast("Your demographic data has been removed from your profile", "success");
        onClose();
      } else {
        showToast("Failed to delete data. Please try again.", "error");
      }
    } catch {
      showToast("Failed to delete data. Please try again.", "error");
    } finally {
      setDeleting(false);
    }
  };

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

        <div className="mb-6 flex flex-col items-center gap-1">
          <span className="text-xs font-label font-bold uppercase tracking-widest text-outline">
            Pending balance
          </span>
          <div className="flex items-baseline gap-1">
            <span className="font-headline text-4xl font-extrabold tracking-tighter text-on-surface">
              {loadingWithdrawal ? "..." : withdrawalData ? formatTokenBalance(withdrawalData.pendingBalanceUnits) : "—"}
            </span>
            <span className="font-headline text-xl font-bold text-secondary">
              {rewardSymbol}
            </span>
          </div>
          <span className="font-body text-xs text-on-surface-variant">
            Min withdrawal: {loadingWithdrawal ? "..." : withdrawalData ? formatTokenBalance(withdrawalData.thresholdUnits) : "—"} {rewardSymbol}
          </span>
          {withdrawalData && (
            <p className="mt-2 font-body text-[11px] text-on-surface-variant">
              {destination
                ? `Paid to your wallet ${truncateAddress(destination)}`
                : "Connect your Stellar wallet to withdraw."}
            </p>
          )}
          {confirming && destination ? (
            <div className="mt-3 w-full rounded-xl bg-surface-container-low p-3 text-center">
              <p className="font-body text-xs text-on-surface">
                Send{" "}
                <strong>
                  {withdrawalData ? formatTokenBalance(withdrawalData.pendingBalanceUnits) : "—"} {rewardSymbol}
                </strong>{" "}
                to your wallet
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-on-surface-variant">
                {destination}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={withdrawing}
                  className="flex-1 rounded-xl bg-surface-container-high px-4 py-2 font-label text-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-highest disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitWithdraw}
                  disabled={withdrawing}
                  className="flex-1 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {withdrawing ? "Sending..." : "Confirm & send"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleWithdraw}
              disabled={loadingWithdrawal || !withdrawalData?.canWithdraw || withdrawing || !destination}
              className="mt-3 rounded-xl bg-primary px-6 py-2 font-label text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
            >
              Withdraw
            </button>
          )}
        </div>

        {withdrawalData && withdrawalData.withdrawals.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 font-label text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
              Recent withdrawals
            </h3>
            <ul className="divide-y divide-outline-variant/20">
              {withdrawalData.withdrawals.slice(0, 5).map((w) => (
                <li key={w.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <PayoutChip status={w.status} />
                    </div>
                    <span className="font-label text-[10px] text-on-surface-variant">
                      {new Date(w.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                      {" · "}+{formatTokenBalance(w.amountUnits)} {rewardSymbol}
                    </span>
                  </div>
                  {w.txHash && (
                    <p className="mt-1 font-mono text-[10px] text-on-surface-variant">
                      Tx: {w.txHash.slice(0, 10)}...
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowDataSection(!showDataSection)}
            className="flex w-full items-center justify-between rounded-xl bg-surface-container-low p-4 text-left transition-colors hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <span className="font-label text-sm font-semibold text-on-surface">
              View / delete my data
            </span>
            <span className="material-symbols-outlined text-on-surface-variant">
              {showDataSection ? "expand_less" : "expand_more"}
            </span>
          </button>

          {showDataSection && (
            <div className="mt-3 rounded-2xl bg-surface-container-low p-4">
              <p className="mb-3 font-body text-xs text-on-surface-variant">
                We collect country, gender, and age range to improve task quality
                and ensure fair compensation. This data is stored securely and is
                never shared with third parties. You can delete this data at any
                time.
              </p>

              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="font-label text-xs text-outline">Country</span>
                  <span className="font-body text-xs text-on-surface">
                    {formatDemographicField(country)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-label text-xs text-outline">Gender</span>
                  <span className="font-body text-xs text-on-surface">
                    {formatDemographicField(gender)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-label text-xs text-outline">Age range</span>
                  <span className="font-body text-xs text-on-surface">
                    {formatDemographicField(ageRange)}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleDeleteDemographics}
                disabled={deleting || (!country && !gender && !ageRange)}
                className="mt-4 w-full rounded-xl bg-error-container py-2.5 text-center font-label text-sm font-semibold text-on-error-container transition-colors hover:bg-error-container/80 focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
              >
                {deleting ? "Removing..." : "Remove my data"}
              </button>
            </div>
          )}
        </div>

        {/* Only link to stellar.expert when walletAddress is a real Stellar `G…`
            key. An account that has not claimed a wallet yet may still carry a
            legacy EVM `0x…` here, which would 404 on the stellar.expert /account/
            path — hide the link rather than show a dead one. */}
        {isValidStellarAddress(walletAddress) && (
          <a
            href={`${explorerUrl}/account/${walletAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-6 block w-full rounded-xl bg-surface-container-high py-3 text-center font-label text-sm font-semibold text-primary transition-colors hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            View on explorer
          </a>
        )}

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

        <div className="mt-6 border-t border-outline-variant/20 pt-6">
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full rounded-xl bg-surface-container-high py-3 text-center font-label text-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60"
          >
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </div>
    </div>
  );
}
