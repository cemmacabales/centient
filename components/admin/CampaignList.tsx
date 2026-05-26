"use client";

import { useState } from "react";
import Link from "next/link";

interface Campaign {
  id: string;
  name: string;
  defaultResponseTarget: number;
  taskCount: number;
  createdAt: string;
}

interface CampaignListProps {
  initialCampaigns: Campaign[];
}

export default function CampaignList({ initialCampaigns }: CampaignListProps) {
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [showNewModal, setShowNewModal] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleCreate(name: string, defaultResponseTarget: number) {
    setLoading(true);
    const res = await fetch("/api/admin/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, defaultResponseTarget }),
    });
    if (res.ok) {
      const newCampaign = await res.json();
      setCampaigns([...campaigns, newCampaign]);
      setShowNewModal(false);
    }
    setLoading(false);
  }

  if (campaigns.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
            Campaigns
          </h1>
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            New Campaign
          </button>
        </div>

        <div className="flex flex-col items-center justify-center rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-12 text-center">
          <span className="material-symbols-outlined text-[48px] text-outline" aria-hidden="true">
            campaign
          </span>
          <h3 className="mt-4 font-headline text-lg font-bold text-on-surface">
            No campaigns yet
          </h3>
          <p className="mt-1 font-body text-sm text-on-surface-variant">
            Create one to start uploading tasks.
          </p>
          <button
            onClick={() => setShowNewModal(true)}
            className="mt-4 rounded-full bg-primary px-6 py-2.5 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90"
          >
            Create Campaign
          </button>
        </div>

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Campaigns
        </h1>
        <button
          onClick={() => setShowNewModal(true)}
          className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          New Campaign
        </button>
      </div>

      <div className="overflow-hidden rounded-3xl border border-outline-variant/40 bg-surface-container-lowest shadow-[0_4px_24px_rgba(25,28,30,0.04)]">
        <table className="w-full">
          <thead>
            <tr className="border-b border-outline-variant/30">
              <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                Campaign Name
              </th>
              <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                Tasks Uploaded
              </th>
              <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
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
                <td className="px-6 py-4 font-body text-sm font-semibold text-on-surface">
                  {c.name}
                </td>
                <td className="px-6 py-4 font-body text-sm text-on-surface-variant">
                  {c.taskCount}
                </td>
                <td className="px-6 py-4 font-body text-sm text-on-surface-variant">
                  {new Date(c.createdAt).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 text-right">
                  <Link
                    href={`/admin/campaigns/${c.id}`}
                    className="rounded-full px-4 py-2 font-label text-sm font-semibold text-primary transition-opacity hover:opacity-80"
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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

interface NewCampaignModalProps {
  onSubmit: (name: string, defaultResponseTarget: number) => void;
  onClose: () => void;
  loading: boolean;
}

function NewCampaignModal({ onSubmit, onClose, loading }: NewCampaignModalProps) {
  const [name, setName] = useState("");
  const [defaultResponseTarget, setDefaultResponseTarget] = useState(50);

  const canSubmit = name.trim();

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
            if (canSubmit) onSubmit(name.trim(), defaultResponseTarget);
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
