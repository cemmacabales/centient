"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface UserTableItem {
  walletAddress: string;
  createdAt: string;
  submissionCount: number;
  totalEarned: string;
  goldCorrect: number;
  goldAttempted: number;
  goldAccuracyPct: number | null;
  isBanned: boolean;
  bannedAt: string | null;
  bannedReason: string | null;
  banCount: number;
  bannedUntil: string | null;
  country: string | null;
  gender: string | null;
  ageRange: string | null;
  onboardingCompleted: boolean;
  lastSubmissionAt: string | null;
}

type SortKey =
  | "createdAt"
  | "submissionCount"
  | "totalEarned"
  | "goldAccuracyPct"
  | "lastSubmissionAt";
type SortDir = "asc" | "desc";

interface UserTableProps {
  rows: UserTableItem[];
  rewardSymbol: string;
}

export default function UserTable({ rows, rewardSymbol }: UserTableProps) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("lastSubmissionAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "banned">("all");
  const [pending, startTransition] = useTransition();
  const [pendingWallet, setPendingWallet] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "banned" && !r.isBanned) return false;
      if (statusFilter === "active" && r.isBanned) return false;
      if (!term) return true;
      return (
        r.walletAddress.toLowerCase().includes(term) ||
        (r.country ?? "").toLowerCase().includes(term) ||
        (r.ageRange ?? "").toLowerCase().includes(term) ||
        (r.gender ?? "").toLowerCase().includes(term)
      );
    });
  }, [rows, search, statusFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
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
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  async function handleBanToggle(row: UserTableItem) {
    const action = row.isBanned ? "unban" : "ban";
    const reason =
      action === "ban" ? prompt("Optional reason for the audit log:", "operator: manual ban") : null;
    if (action === "ban" && reason === null) return; // user cancelled
    setPendingWallet(row.walletAddress);
    try {
      const res = await fetch(`/api/admin/users/${row.walletAddress}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reason || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ type: "error", text: body.error ?? "Action failed." });
      } else {
        setFeedback({ type: "success", text: action === "ban" ? "User banned." : "User unbanned." });
        startTransition(() => router.refresh());
      }
    } finally {
      setPendingWallet(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by wallet, country, age, gender…"
          className="w-full max-w-sm rounded-full border border-outline-variant/40 bg-surface-container-lowest px-4 py-2 font-body text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
        />
        <div className="flex items-center gap-1 rounded-full bg-surface-container-low p-1 font-label text-xs font-semibold">
          {(["all", "active", "banned"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setStatusFilter(opt)}
              className={`rounded-full px-3 py-1 transition-colors ${
                statusFilter === opt
                  ? "bg-primary text-on-primary"
                  : "text-on-surface-variant hover:bg-surface-container-lowest"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
        {feedback && (
          <div
            className={`rounded-lg px-3 py-1.5 font-label text-xs font-semibold ${
              feedback.type === "success" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"
            }`}
          >
            {feedback.text}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-outline-variant/30 font-label text-xs font-bold uppercase tracking-wider text-outline">
                <th className="px-4 py-3">Wallet</th>
                <th className="px-4 py-3">Demographics</th>
                <SortHeader
                  label="Joined"
                  active={sortKey === "createdAt"}
                  dir={sortDir}
                  onClick={() => toggleSort("createdAt")}
                />
                <SortHeader
                  label="Last seen"
                  active={sortKey === "lastSubmissionAt"}
                  dir={sortDir}
                  onClick={() => toggleSort("lastSubmissionAt")}
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
                  label="Gold"
                  active={sortKey === "goldAccuracyPct"}
                  dir={sortDir}
                  onClick={() => toggleSort("goldAccuracyPct")}
                />
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {sorted.map((row) => (
                <tr key={row.walletAddress} className="hover:bg-surface-container-low/40">
                  <td className="px-4 py-3 font-mono text-xs text-on-surface">
                    <a
                      href={`/admin/users/${row.walletAddress}`}
                      className="hover:underline"
                    >
                      {truncate(row.walletAddress)}
                    </a>
                  </td>
                  <td className="px-4 py-3 font-body text-xs text-on-surface-variant">
                    {row.country || row.gender || row.ageRange ? (
                      <div className="flex flex-wrap gap-1">
                        {row.country && <Chip>{row.country}</Chip>}
                        {row.gender && <Chip>{row.gender}</Chip>}
                        {row.ageRange && <Chip>{row.ageRange}</Chip>}
                        {row.onboardingCompleted && <Chip tone="ok">onboarded</Chip>}
                      </div>
                    ) : (
                      <span className="text-outline">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-body text-xs text-on-surface-variant">
                    {new Date(row.createdAt).toLocaleDateString("en-US")}
                  </td>
                  <td className="px-4 py-3 font-body text-xs text-on-surface-variant">
                    {row.lastSubmissionAt
                      ? new Date(row.lastSubmissionAt).toLocaleDateString("en-US")
                      : "—"}
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
                          row.bannedReason ?? "banned",
                          row.bannedUntil ? `until ${new Date(row.bannedUntil).toLocaleString()}` : "",
                          row.banCount > 0 ? `ban #${row.banCount}` : "",
                        ].filter(Boolean).join(" · ")}
                      >
                        {row.banCount >= 3 && !row.bannedUntil ? "banned" : "cooldown"}
                      </span>
                    ) : (
                      <span className="rounded-full bg-surface-container-high px-3 py-1 font-label text-xs font-semibold text-on-surface-variant">
                        active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleBanToggle(row)}
                      disabled={pending || (pendingWallet === row.walletAddress)}
                      className={`rounded-full px-3 py-1.5 font-label text-xs font-bold transition-opacity ${
                        row.isBanned
                          ? "bg-surface-container-high text-on-surface hover:bg-primary-container hover:text-on-primary-container"
                          : "bg-error-container text-on-error-container hover:opacity-80"
                      } disabled:opacity-50`}
                    >
                      {row.isBanned ? "Unban" : "Ban"}
                    </button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-4 py-8 text-center font-body text-sm text-on-surface-variant"
                  >
                    {rows.length === 0
                      ? "No users yet."
                      : "No users match the current filter."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok";
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 font-label text-[10px] font-semibold uppercase tracking-wider ${
        tone === "ok"
          ? "bg-green-100 text-green-800"
          : "bg-surface-container-high text-on-surface-variant"
      }`}
    >
      {children}
    </span>
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
  row: UserTableItem,
  key: SortKey,
): number | string | null {
  switch (key) {
    case "createdAt":
      return new Date(row.createdAt).getTime();
    case "lastSubmissionAt":
      return row.lastSubmissionAt ? new Date(row.lastSubmissionAt).getTime() : null;
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
