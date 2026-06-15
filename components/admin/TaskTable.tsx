"use client";

import { useEffect, useMemo, useState } from "react";

export interface TaskTableSubmission {
  id: string;
  walletAddress: string;
  choice: string;
  reason: string;
  payoutStatus: string;
  payoutError?: string | null;
  payoutTxHash: string | null;
  createdAt: string;
}

export interface TaskTableItem {
  id: string;
  prompt: string;
  promptPreview: string;
  responseA: string;
  responseB: string;
  category: string | null;
  isGold: boolean;
  goldAnswer: string | null;
  submissionCount: number;
  majorityAnswer?: string | null;
  agreementScore?: number | null;
  recentSubmissions: TaskTableSubmission[];
  disabled: boolean;         
}

type TypeFilter = "all" | "regular" | "gold";

interface TaskTableProps {
  items: TaskTableItem[];
  categories: string[];
}

export default function TaskTable({ items: initialItems, categories }: TaskTableProps) {
  const [items, setItems] = useState(initialItems);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return items.filter((r) => {
      if (typeFilter === "regular" && r.isGold) return false;
      if (typeFilter === "gold" && !r.isGold) return false;
      if (categoryFilter && r.category !== categoryFilter) return false;
      return true;
    });
  }, [items, typeFilter, categoryFilter]);

  const handleTaskUpdate = (updated: TaskTableItem) => {
    setItems((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-full bg-surface-container-high p-1">
          {(["all", "regular", "gold"] as TypeFilter[]).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setTypeFilter(opt)}
              className={`rounded-full px-3 py-1 font-label text-xs font-bold uppercase tracking-wider transition-colors ${
                typeFilter === opt
                  ? "bg-primary text-on-primary"
                  : "text-on-surface-variant hover:bg-surface-container-low"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          <CategoryChip
            active={categoryFilter === null}
            onClick={() => setCategoryFilter(null)}
          >
            All categories
          </CategoryChip>
          {categories.map((c) => (
            <CategoryChip
              key={c}
              active={categoryFilter === c}
              onClick={() => setCategoryFilter(c)}
            >
              {c}
            </CategoryChip>
          ))}
        </div>

        <div className="ml-auto font-body text-sm text-on-surface-variant">
          {filtered.length} of {items.length} tasks
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-outline-variant/30 font-label text-xs font-bold uppercase tracking-wider text-outline">
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Prompt</th>
              <th className="px-4 py-3 text-right">Submissions</th>
              <th className="px-4 py-3 text-center">Disabled</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {filtered.map((row) => (
              <TaskRowView
                key={row.id}
                row={row}
                expanded={expandedId === row.id}
                onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                onUpdate={handleTaskUpdate}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center font-body text-sm text-on-surface-variant"
                >
                  No tasks match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 font-label text-xs font-semibold transition-colors ${
        active
          ? "bg-primary-container/60 text-on-primary-container"
          : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container"
      }`}
    >
      {children}
    </button>
  );
}

function TaskRowView({
  row,
  expanded,
  onToggle,
  onUpdate,
}: {
  row: TaskTableItem;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (updated: TaskTableItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState(row.prompt);
  const [editResponseA, setEditResponseA] = useState(row.responseA);
  const [editResponseB, setEditResponseB] = useState(row.responseB);
  const [editDisabled, setEditDisabled] = useState(row.disabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the edit fields whenever the underlying row changes (e.g. another
  // admin's update propagates down as a new prop). Skipped while actively
  // editing so an in-flight edit is never clobbered by a background refresh.
  useEffect(() => {
    if (editing) return;
    setEditPrompt(row.prompt);
    setEditResponseA(row.responseA);
    setEditResponseB(row.responseB);
    setEditDisabled(row.disabled);
  }, [row.prompt, row.responseA, row.responseB, row.disabled, editing]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tasks/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: editPrompt,
          responseA: editResponseA,
          responseB: editResponseB,
          disabled: editDisabled,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Update failed");
      }
      const updated = await res.json();
      // The PATCH response only carries the editable fields — merge them into the
      // existing row so submissionCount / recentSubmissions / category are kept,
      // and recompute promptPreview the same way the server does.
      onUpdate({
        ...row,
        prompt: updated.prompt,
        responseA: updated.responseA,
        responseB: updated.responseB,
        disabled: updated.disabled,
        promptPreview:
          updated.prompt.length > 160 ? `${updated.prompt.slice(0, 157)}…` : updated.prompt,
      });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors hover:bg-surface-container-low"
      >
        <td className="px-4 py-3 font-mono text-xs text-on-surface">{row.id}</td>
        <td className="px-4 py-3 font-body text-xs text-on-surface-variant">
          {row.category ?? "—"}
        </td>
        <td className="px-4 py-3">
          {row.isGold ? (
            <span className="rounded-full bg-secondary-container/60 px-3 py-1 font-label text-xs font-bold uppercase tracking-wide text-on-secondary-container">
              gold
            </span>
          ) : (
            <span className="rounded-full bg-surface-container-high px-3 py-1 font-label text-xs font-semibold text-on-surface-variant">
              regular
            </span>
          )}
        </td>
        <td className="px-4 py-3 font-body text-sm text-on-surface">{row.promptPreview}</td>
        <td className="px-4 py-3 text-right font-label text-sm font-semibold text-on-surface">
          {row.submissionCount}
        </td>
        <td className="px-4 py-3 text-center">
          {row.disabled ? (
            <span className="rounded-full bg-error-container/60 px-2 py-0.5 font-label text-xs font-bold text-on-error-container">
              disabled
            </span>
          ) : (
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-label text-xs text-on-surface-variant">
              active
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="rounded-full bg-primary-container px-3 py-1 font-label text-xs font-bold text-on-primary-container hover:bg-primary"
          >
            Edit
          </button>
        </td>
      </tr>
      {expanded && !editing ? (
        <tr>
          <td colSpan={7} className="bg-surface-container-low px-4 py-4">
            <TaskDetailBlock row={row} />
          </td>
        </tr>
      ) : null}
      {editing ? (
        <tr>
          <td colSpan={7} className="bg-surface-container-low px-4 py-4">
            <div className="space-y-3">
              <div>
                <label className="font-label text-xs font-bold uppercase text-outline">
                  Prompt
                </label>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-2 font-body text-sm text-on-surface"
                />
              </div>
              <div>
                <label className="font-label text-xs font-bold uppercase text-outline">
                  Response A
                </label>
                <textarea
                  value={editResponseA}
                  onChange={(e) => setEditResponseA(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-2 font-body text-sm text-on-surface"
                />
              </div>
              <div>
                <label className="font-label text-xs font-bold uppercase text-outline">
                  Response B
                </label>
                <textarea
                  value={editResponseB}
                  onChange={(e) => setEditResponseB(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-2 font-body text-sm text-on-surface"
                />
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editDisabled}
                    onChange={(e) => setEditDisabled(e.target.checked)}
                  />
                  <span className="font-body text-sm text-on-surface">
                    Disabled (won't be served to labelers)
                  </span>
                </label>
              </div>
              {error && <div className="text-sm text-error">{error}</div>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded-full bg-primary px-4 py-2 font-label text-sm font-bold text-on-primary disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-full bg-surface-container-high px-4 py-2 font-label text-sm font-bold text-on-surface-variant"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TaskDetailBlock({ row }: { row: TaskTableItem }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Prompt
        </div>
        <p className="mt-1 whitespace-pre-wrap font-body text-sm text-on-surface">
          {row.prompt}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ResponseBlock
          label="Response A"
          text={row.responseA}
          isGoldAnswer={row.isGold && row.goldAnswer === "A"}
        />
        <ResponseBlock
          label="Response B"
          text={row.responseB}
          isGoldAnswer={row.isGold && row.goldAnswer === "B"}
        />
      </div>

      {!row.isGold && row.agreementScore != null && (
        <div className="rounded-xl bg-surface-container-lowest p-4">
          <div className="flex items-center gap-3">
            <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
              Inter-Annotator Agreement
            </div>
            <span
              className={`rounded-full px-2 py-0.5 font-label text-xs font-bold ${
                row.agreementScore >= 0.7
                  ? "bg-primary-container text-on-primary-container"
                  : row.agreementScore >= 0.5
                  ? "bg-tertiary-container text-on-tertiary-container"
                  : "bg-error-container text-on-error-container"
              }`}
            >
              {Math.round(row.agreementScore * 100)}% — Majority: {row.majorityAnswer}
            </span>
          </div>
        </div>
      )}

      <div>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Recent submissions (last 20)
        </div>
        {row.recentSubmissions.length === 0 ? (
          <div className="mt-2 font-body text-sm text-on-surface-variant">
            No submissions yet.
          </div>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg bg-surface-container-lowest">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="font-label font-bold uppercase tracking-wider text-outline">
                  <th className="px-3 py-2">Wallet</th>
                  <th className="px-3 py-2">Choice</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Payout Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {row.recentSubmissions.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2 font-mono text-xs text-on-surface-variant">
                      {truncate(s.walletAddress)}
                    </td>
                    <td className="px-3 py-2 font-label font-semibold text-on-surface">
                      {s.choice}
                    </td>
                    <td className="px-3 py-2 font-body text-on-surface">{s.reason}</td>
                    <td className="px-3 py-2 font-label font-semibold text-on-surface-variant">
                      {s.payoutStatus}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-error">
                      {s.payoutError || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ResponseBlock({
  label,
  text,
  isGoldAnswer,
}: {
  label: string;
  text: string;
  isGoldAnswer: boolean;
}) {
  return (
    <div className="rounded-xl bg-surface-container-lowest p-4">
      <div className="flex items-center justify-between">
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          {label}
        </div>
        {isGoldAnswer ? (
          <span className="rounded-full bg-primary-container/50 px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wide text-on-primary-container">
            gold answer
          </span>
        ) : null}
      </div>
      <p className="mt-2 whitespace-pre-wrap font-body text-sm text-on-surface">
        {text.length === 0 ? <em className="text-on-surface-variant">(empty)</em> : text}
      </p>
    </div>
  );
}

function truncate(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
