"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { truncateAddress } from "@/lib/wallet";

export interface DisputeRow {
  id: string;
  walletAddress: string;
  reason: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface ActionState {
  disputeId: string;
  loading: boolean;
  error: string | null;
}

export default function DisputeTable({ rows }: { rows: DisputeRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [actionState, setActionState] = useState<ActionState | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function resolve(id: string, unban: boolean) {
    setActionState({ disputeId: id, loading: true, error: null });
    try {
      const res = await fetch(`/api/admin/disputes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resolve", unban }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionState({ disputeId: id, loading: false, error: data.error ?? "Action failed." });
      } else {
        setActionState(null);
        startTransition(() => router.refresh());
      }
    } catch {
      setActionState({ disputeId: id, loading: false, error: "Network error." });
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl bg-surface-container-lowest p-8 text-center">
        <p className="font-body text-sm text-on-surface-variant">No open disputes.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const isExpanded = expanded === row.id;
        const busy = actionState?.disputeId === row.id && actionState.loading;
        const rowError = actionState?.disputeId === row.id ? actionState.error : null;

        return (
          <div
            key={row.id}
            className="rounded-2xl bg-surface-container-lowest p-5 shadow-[0_4px_16px_rgba(25,28,30,0.04)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={`/admin/users/${row.walletAddress}`}
                    className="font-mono text-sm font-semibold text-primary hover:underline"
                  >
                    {truncateAddress(row.walletAddress)}
                  </a>
                  <span className="rounded-full bg-yellow-100 px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-yellow-800">
                    open
                  </span>
                </div>
                <p className="mt-1 font-label text-[10px] text-on-surface-variant">
                  Submitted {new Date(row.createdAt).toLocaleString("en-US")}
                </p>
                <p
                  className={`mt-2 font-body text-sm text-on-surface ${isExpanded ? "" : "line-clamp-2"}`}
                >
                  {row.reason}
                </p>
                {row.reason.length > 120 && (
                  <button
                    type="button"
                    onClick={() => setExpanded(isExpanded ? null : row.id)}
                    className="mt-1 font-label text-xs text-primary hover:underline"
                  >
                    {isExpanded ? "Show less" : "Read more"}
                  </button>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => resolve(row.id, true)}
                  disabled={busy}
                  className="rounded-full bg-primary px-4 py-2 font-label text-xs font-bold text-on-primary transition-opacity disabled:opacity-50 hover:opacity-80"
                >
                  Resolve + Unban
                </button>
                <button
                  type="button"
                  onClick={() => resolve(row.id, false)}
                  disabled={busy}
                  className="rounded-full bg-surface-container-high px-4 py-2 font-label text-xs font-bold text-on-surface-variant transition-opacity disabled:opacity-50 hover:bg-surface-container-highest"
                >
                  Resolve only
                </button>
              </div>
            </div>
            {rowError && (
              <p className="mt-2 font-label text-xs text-error">{rowError}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
