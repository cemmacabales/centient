"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { truncateAddress } from "@/lib/wallet";

export interface FlaggedWithdrawalRow {
  id: string;
  userId: string;
  walletAddress: string | null;
  reason: string;
  severity: "CRITICAL" | "HIGH" | "LOW";
  detail: Record<string, unknown> | null;
  balance: string;
  createdAt: string;
  email: string | null;
  userWallet: string | null;
  userIsBanned: boolean;
}

type Action = "approve" | "reject" | "ban";

interface ActionState {
  id: string;
  loading: boolean;
  error: string | null;
}

const SEVERITY_STYLES: Record<FlaggedWithdrawalRow["severity"], string> = {
  CRITICAL: "bg-red-100 text-red-800",
  HIGH: "bg-orange-100 text-orange-800",
  LOW: "bg-yellow-100 text-yellow-800",
};

const REASON_LABELS: Record<string, string> = {
  BANNED_IDENTITY: "Banned identity",
  SHARED_WALLET: "Shared wallet",
  INELIGIBLE: "Failed eligibility",
};

function describeDetail(reason: string, detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  if (reason === "SHARED_WALLET") {
    return `Wallet cashing out for ${detail.accountCount} accounts.`;
  }
  if (reason === "BANNED_IDENTITY") {
    return `Banned ${String(detail.identifierType).toLowerCase()}: ${detail.identifierValue}${
      detail.reason ? ` — ${detail.reason}` : ""
    }`;
  }
  if (reason === "INELIGIBLE") {
    return `Gate: ${detail.reason} (required ${detail.required}, had ${detail.actual}).`;
  }
  return "";
}

export default function FlaggedWithdrawalTable({
  rows,
  tokenSymbol,
}: {
  rows: FlaggedWithdrawalRow[];
  tokenSymbol: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [actionState, setActionState] = useState<ActionState | null>(null);
  const [confirmingBan, setConfirmingBan] = useState<string | null>(null);

  async function resolve(id: string, action: Action) {
    setActionState({ id, loading: true, error: null });
    try {
      const res = await fetch(`/api/admin/flagged-withdrawals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, confirm: action === "ban" ? true : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionState({ id, loading: false, error: data.error ?? "Action failed." });
      } else {
        setActionState(null);
        setConfirmingBan(null);
        startTransition(() => router.refresh());
      }
    } catch {
      setActionState({ id, loading: false, error: "Network error." });
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl bg-surface-container-lowest p-8 text-center">
        <p className="font-body text-sm text-on-surface-variant">No flagged withdrawals to review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const busy = actionState?.id === row.id && actionState.loading;
        const rowError = actionState?.id === row.id ? actionState.error : null;
        const isConfirmingBan = confirmingBan === row.id;

        return (
          <div
            key={row.id}
            className="rounded-2xl bg-surface-container-lowest p-5 shadow-[0_4px_16px_rgba(25,28,30,0.04)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider ${SEVERITY_STYLES[row.severity]}`}
                  >
                    {row.severity}
                  </span>
                  <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                    {REASON_LABELS[row.reason] ?? row.reason}
                  </span>
                  {row.userIsBanned && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-red-800">
                      already banned
                    </span>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-body text-sm text-on-surface">
                  {row.email && <span className="font-semibold">{row.email}</span>}
                  {row.userWallet && (
                    <a
                      href={`/admin/users/${row.userWallet}`}
                      className="font-mono text-sm font-semibold text-primary hover:underline"
                    >
                      {truncateAddress(row.userWallet)}
                    </a>
                  )}
                  <span className="text-on-surface-variant">
                    balance {row.balance} {tokenSymbol}
                  </span>
                </div>

                <p className="mt-1 font-body text-sm text-on-surface-variant">
                  {describeDetail(row.reason, row.detail)}
                </p>
                <p className="mt-1 font-label text-[10px] text-outline">
                  Flagged {new Date(row.createdAt).toLocaleString("en-US")}
                </p>
              </div>

              <div className="flex shrink-0 flex-col gap-2">
                {!isConfirmingBan ? (
                  <>
                    <button
                      type="button"
                      onClick={() => resolve(row.id, "approve")}
                      disabled={busy}
                      className="rounded-full bg-primary px-4 py-2 font-label text-xs font-bold text-on-primary transition-opacity disabled:opacity-50 hover:opacity-80"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => resolve(row.id, "reject")}
                      disabled={busy}
                      className="rounded-full bg-surface-container-high px-4 py-2 font-label text-xs font-bold text-on-surface-variant transition-opacity disabled:opacity-50 hover:bg-surface-container-highest"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingBan(row.id)}
                      disabled={busy}
                      className="rounded-full bg-red-600 px-4 py-2 font-label text-xs font-bold text-white transition-opacity disabled:opacity-50 hover:opacity-80"
                    >
                      Ban account
                    </button>
                  </>
                ) : (
                  <div className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
                    <p className="font-label text-[11px] font-bold text-red-800">
                      Ban this account? This blocks its email, wallet and account from
                      future withdrawals.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => resolve(row.id, "ban")}
                        disabled={busy}
                        className="rounded-full bg-red-600 px-4 py-2 font-label text-xs font-bold text-white transition-opacity disabled:opacity-50 hover:opacity-80"
                      >
                        Confirm ban
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingBan(null)}
                        disabled={busy}
                        className="rounded-full bg-surface-container-high px-4 py-2 font-label text-xs font-bold text-on-surface-variant transition-opacity disabled:opacity-50 hover:bg-surface-container-highest"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {rowError && <p className="mt-2 font-label text-xs text-error">{rowError}</p>}
          </div>
        );
      })}
    </div>
  );
}
