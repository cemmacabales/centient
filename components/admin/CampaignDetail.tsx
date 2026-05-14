"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

interface TaskProgress {
  taskId: string;
  prompt: string;
  responseTarget: number;
  responseCount: number;
  pct: number;
}

interface CampaignDetailProps {
  campaignId: string;
  campaignName: string;
  defaultResponseTarget: number;
}

export default function CampaignDetail({ campaignId, campaignName, defaultResponseTarget }: CampaignDetailProps) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchTasks();
  }, [campaignId]);

  async function fetchTasks() {
    setLoading(true);
    const res = await fetch(`/api/admin/campaigns/${campaignId}/tasks`);
    if (res.ok) {
      const data = await res.json();
      setTasks(data);
    }
    setLoading(false);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadResult(null);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`/api/admin/campaigns/${campaignId}/upload`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      const result = await res.json();
      setUploadResult(result);
      fetchTasks();
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleDownloadTemplate() {
    const res = await fetch("/api/admin/campaigns/template.csv");
    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "campaign_template.csv";
      a.click();
      window.URL.revokeObjectURL(url);
    }
  }

  const sorted = [...tasks].sort((a, b) => a.pct - b.pct);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href="/admin/campaigns"
          className="flex items-center gap-1 rounded-full px-3 py-1.5 font-label text-sm font-semibold text-outline transition-colors hover:bg-surface-container-low"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back
        </Link>
      </div>

      <div className="flex items-baseline gap-4">
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          {campaignName}
        </h1>
        <span className="font-body text-sm text-on-surface-variant">
          Target: {defaultResponseTarget} responses per task
        </span>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleDownloadTemplate}
          className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
        >
          <span className="material-symbols-outlined text-[18px]">download</span>
          Download Template
        </button>

        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={handleUpload}
          disabled={uploading}
          className="hidden"
          id="csv-upload"
        />
        <label
          htmlFor="csv-upload"
          className={`flex cursor-pointer items-center gap-2 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 ${
            uploading ? "opacity-50" : ""
          }`}
        >
          <span className="material-symbols-outlined text-[18px]">upload_file</span>
          {uploading ? "Uploading..." : "Upload CSV"}
        </label>
      </div>

      {uploadResult && (
        <div className="rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-4">
          <div className="flex items-center gap-4">
            <span className="material-symbols-outlined text-primary text-[24px]">check_circle</span>
            <div>
              <div className="font-label text-sm font-bold text-on-surface">
                Import complete
              </div>
              <div className="font-body text-xs text-on-surface-variant">
                Inserted: {uploadResult.inserted}, Skipped: {uploadResult.skipped}
              </div>
            </div>
          </div>
          {uploadResult.errors.length > 0 && (
            <div className="mt-3 space-y-1">
              {uploadResult.errors.slice(0, 10).map((err, i) => (
                <div key={i} className="rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container">
                  {err}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <section className="rounded-3xl border border-outline-variant/40 bg-surface-container-lowest shadow-[0_4px_24px_rgba(25,28,30,0.04)]">
        <div className="border-b border-outline-variant/30 px-6 py-4">
          <h2 className="font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
            Task Progress — sorted by lowest completion first
          </h2>
        </div>

        {loading ? (
          <div className="p-12 text-center font-body text-sm text-on-surface-variant">
            Loading...
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-12 text-center">
            <p className="font-body text-sm text-on-surface-variant">
              No tasks yet. Upload a CSV to get started.
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/20">
                <th className="px-6 py-3 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Prompt
                </th>
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Target
                </th>
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Responses
                </th>
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  %
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr
                  key={t.taskId}
                  className="border-b border-outline-variant/10 last:border-0 transition-colors hover:bg-surface-container-low/40"
                >
                  <td className="px-6 py-3 font-body text-sm text-on-surface">
                    {t.prompt.length > 80 ? t.prompt.slice(0, 80) + "..." : t.prompt}
                  </td>
                  <td className="px-6 py-3 text-right font-body text-sm text-on-surface-variant">
                    {t.responseTarget}
                  </td>
                  <td className="px-6 py-3 text-right font-body text-sm text-on-surface-variant">
                    {t.responseCount}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <span
                      className={`rounded-full px-2 py-0.5 font-label text-xs font-bold ${
                        t.pct >= 100
                          ? "bg-secondary-container text-on-secondary-container"
                          : t.pct >= 50
                          ? "bg-tertiary-container text-on-tertiary-container"
                          : "bg-error-container text-on-error-container"
                      }`}
                    >
                      {t.pct}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}