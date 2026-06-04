"use client";

import { useState } from "react";
import Link from "next/link";
import { parseUnits } from "viem";

interface Campaign {
  id: string;
  name: string;
  defaultResponseTarget: number;
  rewardWei: string;
  taskCount: number;
  totalResponses: number;
  completionPct: number;
  createdAt: string;
  pausedAt: string | null;
  ownerEmail: string | null;
}

interface AggregateStats {
  totalCampaigns: number;
  totalTasks: number;
  totalResponses: number;
  overallCompletionPct: number;
}

interface CampaignListProps {
  initialCampaigns: Campaign[];
  aggregate: AggregateStats;
  showOwner?: boolean;
  hideNewButton?: boolean;
}

export default function CampaignList({
  initialCampaigns,
  aggregate,
  showOwner = false,
  hideNewButton = false,
}: CampaignListProps) {
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [showNewModal, setShowNewModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  async function handleCreate(name: string, defaultResponseTarget: number, rewardWei: string) {
    setLoading(true);
    const res = await fetch("/api/admin/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, defaultResponseTarget, rewardWei }),
    });
    if (res.ok) {
      const newCampaign = await res.json();
      setCampaigns([...campaigns, { ...newCampaign, totalResponses: 0, completionPct: 0 }]);
      setShowNewModal(false);
    }
    setLoading(false);
  }

  async function handleExport(campaignId: string, format: string = "json") {
    setExporting(campaignId);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}/export?format=${format}`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${campaignId}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // silently ignore — user sees no spinner
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Campaigns
        </h1>
        {!hideNewButton && (
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            New Campaign
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Campaigns" value={String(aggregate.totalCampaigns)} />
        <StatCard label="Tasks" value={String(aggregate.totalTasks)} />
        <StatCard label="Responses" value={String(aggregate.totalResponses)} />
        <StatCard label="Completion" value={`${aggregate.overallCompletionPct}%`} subline="overall" />
      </div>

      {campaigns.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-12 text-center">
          <span className="material-symbols-outlined text-[48px] text-outline" aria-hidden="true">
            campaign
          </span>
          <h3 className="mt-4 font-headline text-lg font-bold text-on-surface">
            No campaigns yet
          </h3>
          <p className="mt-1 font-body text-sm text-on-surface-variant">
            {hideNewButton
              ? "This customer hasn't created any campaigns yet."
              : "Create one to start uploading tasks."}
          </p>
          {!hideNewButton && (
            <button
              onClick={() => setShowNewModal(true)}
              className="mt-4 rounded-full bg-primary px-6 py-2.5 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90"
            >
              Create Campaign
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-3xl border border-outline-variant/40 bg-surface-container-lowest shadow-[0_4px_24px_rgba(25,28,30,0.04)]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/30">
                <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Campaign
                </th>
                {showOwner && (
                  <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                    Owner
                  </th>
                )}
                <th className="px-6 py-4 text-center font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Tasks
                </th>
                <th className="px-6 py-4 text-center font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Responses
                </th>
                <th className="px-6 py-4 text-center font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Completion
                </th>
                <th className="px-6 py-4 text-center font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Status
                </th>
                <th className="px-6 py-4 text-center font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Created
                </th>
                <th className="px-6 py-4 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-outline-variant/20 last:border-0 transition-colors hover:bg-surface-container-low/40"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="font-body text-sm font-semibold text-on-surface">{c.name}</span>
                      {c.pausedAt && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-yellow-800"
                          title={`Paused since ${new Date(c.pausedAt).toLocaleDateString()}`}
                        >
                          <span className="material-symbols-outlined text-[12px]">pause</span>
                          paused
                        </span>
                      )}
                    </div>
                  </td>
                  {showOwner && (
                    <td className="px-6 py-4 font-body text-xs text-on-surface-variant">
                      {c.ownerEmail ?? "—"}
                    </td>
                  )}
                  <td className="px-6 py-4 text-center font-body text-sm text-on-surface-variant">
                    {c.taskCount}
                  </td>
                  <td className="px-6 py-4 text-center font-body text-sm text-on-surface-variant">
                    {c.totalResponses}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 font-label text-xs font-bold ${
                        c.completionPct >= 100
                          ? "bg-secondary-container text-on-secondary-container"
                          : c.completionPct >= 50
                          ? "bg-tertiary-container text-on-tertiary-container"
                          : "bg-error-container text-on-error-container"
                      }`}
                    >
                      {c.completionPct}%
                    </span>
                  </td>
                  <td className="px-6 py-4 text-center">
                    {c.pausedAt ? (
                      <span className="inline-flex rounded-full bg-yellow-100 px-2.5 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-yellow-800">
                        paused
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-secondary-container px-2.5 py-0.5 font-label text-[10px] font-bold uppercase tracking-wider text-on-secondary-container">
                        active
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-center font-body text-sm text-on-surface-variant">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {c.totalResponses > 0 && (
                        <div className="relative">
                          <button
                            onClick={() => handleExport(c.id)}
                            disabled={exporting === c.id}
                            className="flex items-center gap-1 rounded-full px-3 py-1.5 font-label text-xs font-semibold text-primary transition-opacity hover:opacity-80 disabled:opacity-40"
                            title="Export campaign data"
                          >
                            <span className="material-symbols-outlined text-[16px]">download</span>
                            {exporting === c.id ? "..." : "Export"}
                          </button>
                        </div>
                      )}
                      <Link
                        href={`/admin/campaigns/${c.id}`}
                        className="rounded-full px-3 py-1.5 font-label text-xs font-semibold text-primary transition-opacity hover:opacity-80"
                      >
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNewModal && (
        <NewCampaignModal
          onSubmit={handleCreate}
          onClose={() => setShowNewModal(false)}
          loading={loading}
        />
      )}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  subline?: string;
}

function StatCard({ label, value, subline }: StatCardProps) {
  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-[0_8px_24px_rgba(25,28,30,0.06)]">
      <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
        {label}
      </div>
      <div className="mt-2 font-headline text-2xl font-extrabold tracking-tight text-on-surface">
        {value}
      </div>
      {subline ? (
        <div className="mt-1 font-body text-xs text-on-surface-variant">{subline}</div>
      ) : null}
    </section>
  );
}

interface NewCampaignModalProps {
  onSubmit: (name: string, defaultResponseTarget: number, rewardWei: string) => void;
  onClose: () => void;
  loading: boolean;
}

function NewCampaignModal({ onSubmit, onClose, loading }: NewCampaignModalProps) {
  const [name, setName] = useState("");
  const [defaultResponseTarget, setDefaultResponseTarget] = useState(50);
  const [rewardDisplay, setRewardDisplay] = useState("0.05");

  const canSubmit = name.trim() && rewardDisplay.trim() && !isNaN(Number(rewardDisplay)) && Number(rewardDisplay) > 0;

  function handleFormSubmit() {
    if (!canSubmit) return;
    let wei: string;
    try {
      wei = parseUnits(rewardDisplay.trim(), 18).toString();
    } catch {
      return;
    }
    onSubmit(name.trim(), defaultResponseTarget, wei);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-surface-container-lowest p-6 shadow-[0_8px_32px_rgba(25,28,30,0.12)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-headline text-xl font-extrabold tracking-tight text-on-surface">
            New Campaign
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-outline transition-colors hover:bg-surface-container-high"
          >
            ✕
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleFormSubmit();
          }}
          className="mt-6 space-y-4"
        >
          <div>
            <label className="block font-label text-sm font-bold text-on-surface">
              Campaign Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Batch 1 — Coding Tasks"
              required
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
          </div>

          <div>
            <label className="block font-label text-sm font-bold text-on-surface">
              Default Response Target
            </label>
            <input
              type="number"
              value={defaultResponseTarget}
              onChange={(e) => setDefaultResponseTarget(parseInt(e.target.value, 10) || 50)}
              min={1}
              max={10000}
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
            <p className="mt-1 font-body text-xs text-on-surface-variant">
              Per-task submission goal. Can be overridden per task in CSV.
            </p>
          </div>

          <div>
            <label className="block font-label text-sm font-bold text-on-surface">
              Reward per Task (ETH)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={rewardDisplay}
              onChange={(e) => setRewardDisplay(e.target.value)}
              placeholder="0.05"
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
            <p className="mt-1 font-body text-xs text-on-surface-variant">
              Reward amount per submission in display units (e.g., 0.05 for 0.05 tokens).
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-5 py-2.5 font-label text-sm font-semibold text-outline transition-colors hover:bg-surface-container-low"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || loading}
              className="rounded-full bg-primary px-6 py-2.5 font-label text-sm font-semibold text-on-primary shadow-[0_4px_16px_rgba(0,109,61,0.2)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {loading ? "Creating..." : "Create Campaign"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
