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
}

export default function CampaignDetail({ campaignId, campaignName }: CampaignDetailProps) {
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
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          {campaignName}
        </h1>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-6">
          <h2 className="font-headline text-lg font-bold text-on-surface">Upload Tasks (CSV)</h2>
          <p className="mt-1 font-body text-sm text-on-surface-variant">
            Upload a CSV with prompts and response pairs.
          </p>

          <div className="mt-4">
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
              className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-outline-variant bg-surface-container-low px-6 py-4 transition-colors hover:bg-surface-container-high ${
                uploading ? "opacity-50" : ""
              }`}
            >
              <span className="material-symbols-outlined text-[24px] text-primary">
                upload_file
              </span>
              <span className="font-label text-sm font-semibold text-on-surface">
                {uploading ? "Uploading..." : "Choose CSV file"}
              </span>
            </label>
          </div>

          {uploadResult && (
            <div className="mt-4 space-y-2">
              <div className="font-label text-sm font-bold text-on-surface">
                Import complete
              </div>
              <div className="font-body text-xs text-on-surface-variant">
                Inserted: {uploadResult.inserted}, Skipped: {uploadResult.skipped}
              </div>
              {uploadResult.errors.length > 0 && (
                <div className="mt-2 space-y-1">
                  {uploadResult.errors.slice(0, 5).map((err, i) => (
                    <div key={i} className="rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container">
                      {err}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <a
            href="/api/admin/campaigns/template.csv"
            className="mt-4 flex items-center gap-2 font-label text-sm font-semibold text-primary underline"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Download CSV Template
          </a>
        </section>

        <section className="rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-6">
          <h2 className="font-headline text-lg font-bold text-on-surface">Summary</h2>
          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-body text-sm text-on-surface-variant">Total Tasks</span>
              <span className="font-label text-lg font-bold text-on-surface">{tasks.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-body text-sm text-on-surface-variant">Avg. Progress</span>
              <span className="font-label text-lg font-bold text-on-surface">
                {tasks.length > 0
                  ? Math.round(tasks.reduce((s, t) => s + t.pct, 0) / tasks.length)
                  : 0}
                %
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-body text-sm text-on-surface-variant">Needs Attention</span>
              <span className="font-label text-lg font-bold text-on-surface">
                {tasks.filter((t) => t.pct < 100).length}
              </span>
            </div>
          </div>
        </section>
      </div>

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