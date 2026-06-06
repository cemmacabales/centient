"use client";

import { useMemo, useState } from "react";

export interface WalletTableItem {
  walletAddress: string;
  createdAt: string;
  submissionCount: number;
  totalEarned: string;
  goldCorrect: number;
  goldAttempted: number;
  goldAccuracyPct: number | null;
  isBanned: boolean;
  banCount: number;
  bannedUntil: string | null;
}

type SortKey = "createdAt" | "submissionCount" | "totalEarned" | "goldAccuracyPct";
type SortDir = "asc" | "desc";

interface WalletTableProps {
  rows: WalletTableItem[];
  rewardSymbol: string;
}

export default function WalletTable({ rows, rewardSymbol }: WalletTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aVal = sortValue(a, sortKey);
      const bVal = sortValue(b, sortKey);
      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-outline-variant/30 font-label text-xs font-bold uppercase tracking-wider text-outline">
              <th className="px-4 py-3">Wallet</th>
              <SortHeader
                label="Joined"
                active={sortKey === "createdAt"}
                dir={sortDir}
                onClick={() => toggleSort("createdAt")}
              />
              <SortHeader
                label="Submissions"
                active={sortKey === "submissionCount"}
                dir={sortDir}
                onClick={() => toggleSort("submissionCount")}
                align="right"
              />
              <SortHeader
                label="Earned"
                active={sortKey === "totalEarned"}
                dir={sortDir}
                onClick={() => toggleSort("totalEarned")}
                align="right"
              />
              <SortHeader
                label="Gold accuracy"
                active={sortKey === "goldAccuracyPct"}
                dir={sortDir}
                onClick={() => toggleSort("goldAccuracyPct")}
              />
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {sorted.map((row) => (
              <tr key={row.walletAddress}>
                <td className="px-4 py-3 font-mono text-xs text-on-surface">
                  <a
                    href={`/admin/wallets/${row.walletAddress}`}
                    className="hover:underline"
                  >
                    {truncate(row.walletAddress)}
                  </a>
                </td>
                <td className="px-4 py-3 font-body text-xs text-on-surface-variant">
                  {new Date(row.createdAt).toLocaleDateString("en-US")}
                </td>
                <td className="px-4 py-3 text-right font-label text-sm font-semibold text-on-surface">
                  {row.submissionCount}
                </td>
                <td className="px-4 py-3 text-right font-label text-sm font-semibold text-secondary">
                  {row.totalEarned} {rewardSymbol}
                </td>
                <td className="px-4 py-3 font-body text-xs text-on-surface-variant">
                  {row.goldAttempted === 0
                    ? "—"
                    : `${row.goldCorrect} / ${row.goldAttempted} · ${row.goldAccuracyPct}%`}
                </td>
                <td className="px-4 py-3">
                  {row.isBanned ? (
                    <span
                      className={`rounded-full px-3 py-1 font-label text-xs font-bold ${
                        row.banCount >= 3 && !row.bannedUntil
                          ? "bg-error-container text-on-error-container"
                          : "bg-amber-100 text-amber-800"
                      }`}
                      title={[
                        row.banCount > 0 ? `ban #${row.banCount}` : "",
                        row.bannedUntil ? `until ${new Date(row.bannedUntil).toLocaleString()}` : "permanent",
                      ].filter(Boolean).join(" · ")}
                    >
                      {row.banCount >= 3 && !row.bannedUntil ? "paused" : "cooldown"}
                    </span>
                  ) : (
                    <span className="rounded-full bg-surface-container-high px-3 py-1 font-label text-xs font-semibold text-on-surface-variant">
                      active
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center font-body text-sm text-on-surface-variant"
                >
                  No wallets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-4 py-3 ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 font-label text-xs font-bold uppercase tracking-wider transition-colors ${
          active ? "text-on-surface" : "text-outline hover:text-on-surface-variant"
        }`}
      >
        {label}
        {active ? <span aria-hidden="true">{dir === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    </th>
  );
}

function sortValue(
  row: WalletTableItem,
  key: SortKey,
): number | string | null {
  switch (key) {
    case "createdAt":
      return new Date(row.createdAt).getTime();
    case "submissionCount":
      return row.submissionCount;
    case "totalEarned":
      return Number(row.totalEarned);
    case "goldAccuracyPct":
      return row.goldAccuracyPct;
  }
}

function truncate(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
