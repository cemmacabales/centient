"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import ExportModal from "@/components/admin/ExportModal";

interface TaskProgress {
  taskId: string;
  prompt: string;
  responseTarget: number;
  responseCount: number;
  pct: number;
}

interface EditingRow {
  taskId: string | null;
  prompt: string;
  responseTarget: number;
}

interface CampaignDetailProps {
  campaignId: string;
  campaignName: string;
  defaultResponseTarget: number;
  pausedAt: string | null;
  ownerEmail: string | null;
  isReadOnly: boolean;
}

type DeleteConfirm = { taskId: string } | null;

export default function CampaignDetail({
  campaignId,
  campaignName,
  defaultResponseTarget,
  pausedAt: initialPausedAt,
  ownerEmail,
  isReadOnly,
}: CampaignDetailProps) {
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null);
  const [editing, setEditing] = useState<EditingRow | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [pausedAt, setPausedAt] = useState<string | null>(initialPausedAt);
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
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

    const result = await res.json();
    setUploadResult(result);
    if (res.ok) fetchTasks();
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

  async function handleTogglePause() {
    setPausing(true);
    setPauseError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: !pausedAt }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPauseError(body.error ?? "Failed to update pause state");
      } else {
        setPausedAt(body.pausedAt ?? null);
      }
    } catch {
      setPauseError("Network error");
    } finally {
      setPausing(false);
    }
  }

  function handleEdit(task: TaskProgress) {
    setEditing({ taskId: task.taskId, prompt: task.prompt, responseTarget: task.responseTarget });
    setError(null);
  }

  function handleCancelEdit() {
    setEditing(null);
    setError(null);
  }

  async function handleSaveEdit() {
    if (!editing) return;
    if (editing.prompt.trim().length === 0) {
      setError("Prompt cannot be empty");
      return;
    }
    if (!Number.isInteger(editing.responseTarget) || editing.responseTarget < 1) {
      setError("Target must be a positive integer");
      return;
    }

    const original = tasks.find(t => t.taskId === editing.taskId);
    setTasks(prev => prev.map(t =>
      t.taskId === editing.taskId
        ? { ...t, prompt: editing.prompt.trim(), responseTarget: editing.responseTarget, pct: Math.min(100, Math.floor((t.responseCount / editing.responseTarget) * 100)) }
        : t
    ));
    setEditing(null);
    setError(null);

    const res = await fetch(`/api/admin/campaigns/${campaignId}/tasks/${editing.taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: editing.prompt.trim(), responseTarget: editing.responseTarget }),
    });

    if (!res.ok) {
      if (original) {
        setTasks(prev => prev.map(t => t.taskId === editing.taskId ? original : t));
      }
      setError("Failed to save changes");
    }
  }

  function handleStartAdd() {
    setAddingNew(true);
    setEditing({ taskId: null, prompt: "", responseTarget: defaultResponseTarget });
    setError(null);
  }

  function handleCancelAdd() {
    setAddingNew(false);
    setEditing(null);
    setError(null);
  }

  async function handleSaveNew() {
    if (!editing || editing.taskId !== null) return;
    if (editing.prompt.trim().length === 0) {
      setError("Prompt cannot be empty");
      return;
    }
    if (!Number.isInteger(editing.responseTarget) || editing.responseTarget < 1) {
      setError("Target must be a positive integer");
      return;
    }

    const tempId = `new-${Date.now()}`;
    const tempRow: TaskProgress = {
      taskId: tempId,
      prompt: editing.prompt.trim(),
      responseTarget: editing.responseTarget,
      responseCount: 0,
      pct: 0,
    };
    setTasks(prev => [...prev, tempRow]);
    setAddingNew(false);
    setEditing(null);
    setError(null);

    const res = await fetch(`/api/admin/campaigns/${campaignId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: editing.prompt.trim(), responseTarget: editing.responseTarget }),
    });

    if (res.ok) {
      const created = await res.json();
      setTasks(prev => prev.map(t => t.taskId === tempId ? {
        taskId: created.taskId,
        prompt: created.prompt,
        responseTarget: created.responseTarget,
        responseCount: 0,
        pct: 0,
      } : t));
    } else {
      const errData = await res.json().catch(() => ({}));
      if (errData.error === "duplicate_prompt") {
        setError("This prompt already exists in the campaign");
      } else {
        setError("Failed to add task");
      }
      setTasks(prev => prev.filter(t => t.taskId !== tempId));
    }
  }

  function handleDeleteClick(taskId: string) {
    setDeleteConfirm({ taskId });
  }

  function handleCancelDelete() {
    setDeleteConfirm(null);
  }

  async function handleConfirmDelete() {
    if (!deleteConfirm) return;
    const { taskId } = deleteConfirm;
    const original = tasks.find(t => t.taskId === taskId);
    setTasks(prev => prev.filter(t => t.taskId !== taskId));
    setDeleteConfirm(null);

    const res = await fetch(`/api/admin/campaigns/${campaignId}/tasks/${taskId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      if (original) {
        setTasks(prev => [...prev, original]);
      }
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
        {pausedAt && (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-3 py-1 font-label text-xs font-bold text-yellow-800">
            <span className="material-symbols-outlined text-[14px]">pause</span>
            paused since {new Date(pausedAt).toLocaleDateString("en-US")}
          </span>
        )}
      </div>

      {ownerEmail && (
        <p className="font-body text-xs text-on-surface-variant">
          Owner: <span className="font-mono">{ownerEmail}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleDownloadTemplate}
          className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
        >
          <span className="material-symbols-outlined text-[18px]">download</span>
          Download Template
        </button>

        {!isReadOnly && (
          <>
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
          </>
        )}

        <button
          type="button"
          onClick={handleTogglePause}
          disabled={pausing}
          className={`flex items-center gap-2 rounded-xl border px-4 py-2 font-label text-sm font-semibold transition-colors ${
            pausedAt
              ? "border-primary bg-primary-container text-on-primary-container hover:opacity-90"
              : "border-outline-variant bg-surface-container-low text-on-surface hover:bg-surface-container-high"
          } disabled:opacity-50`}
        >
          <span className="material-symbols-outlined text-[18px]">
            {pausedAt ? "play_arrow" : "pause"}
          </span>
          {pausedAt ? "Resume" : "Pause"}
        </button>
        {pauseError && (
          <span className="font-label text-xs font-semibold text-error">{pauseError}</span>
        )}

        <ExportModal campaignId={campaignId} />
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
        <div className="flex items-center justify-between border-b border-outline-variant/30 px-6 py-4">
          <h2 className="font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
            Task Progress — sorted by lowest completion first
          </h2>
          {!addingNew && (
            <button
              onClick={handleStartAdd}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 font-label text-xs font-bold text-on-primary transition-opacity hover:opacity-90"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Prompt
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-12 text-center font-body text-sm text-on-surface-variant">
            Loading...
          </div>
        ) : tasks.length === 0 && !addingNew ? (
          <div className="p-12 text-center">
            <p className="font-body text-sm text-on-surface-variant">
              No tasks yet. Upload a CSV or add one manually.
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/20">
                <th className="px-6 py-3 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
                  Prompt
                </th>
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline w-24">
                  Target
                </th>
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline w-24">
                  Responses
                </th>
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline w-20">
                  %
                </th>
                <th className="px-6 py-3 w-24" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => {
                const isEditing = editing?.taskId === t.taskId;
                return (
                  <tr
                    key={t.taskId}
                    className={`border-b border-outline-variant/10 last:border-0 transition-colors ${
                      isEditing ? "bg-surface-container-low" : "hover:bg-surface-container-low/40"
                    }`}
                  >
                    <td className="px-6 py-3">
                      {isEditing ? (
                        <textarea
                          className="w-full rounded-lg border border-outline-variant bg-surface-container px-3 py-2 font-body text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                          value={editing.prompt}
                          onChange={e => setEditing({ ...editing, prompt: e.target.value })}
                          rows={2}
                          autoFocus
                        />
                      ) : (
                        <span className="font-body text-sm text-on-surface">
                          {t.prompt.length > 80 ? t.prompt.slice(0, 80) + "..." : t.prompt}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      {isEditing ? (
                        <input
                          type="number"
                          min="1"
                          className="w-full rounded-lg border border-outline-variant bg-surface-container px-3 py-2 text-right font-body text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                          value={editing.responseTarget}
                          onChange={e => setEditing({ ...editing, responseTarget: parseInt(e.target.value) || 0 })}
                        />
                      ) : (
                        <span className="block text-right font-body text-sm text-on-surface-variant">
                          {t.responseTarget}
                        </span>
                      )}
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
                    <td className="px-6 py-3">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={handleSaveEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary-container"
                            title="Save"
                          >
                            <span className="material-symbols-outlined text-[18px]">check</span>
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high"
                            title="Cancel"
                          >
                            <span className="material-symbols-outlined text-[18px]">close</span>
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleEdit(t)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high"
                            title="Edit"
                          >
                            <span className="material-symbols-outlined text-[18px]">edit</span>
                          </button>
                          <button
                            onClick={() => handleDeleteClick(t.taskId)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-error-container hover:text-on-error-container"
                            title="Delete"
                          >
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {addingNew && editing && (
                <tr className="border-b border-outline-variant/10 bg-surface-container-low">
                  <td className="px-6 py-3">
                    <textarea
                      className="w-full rounded-lg border border-outline-variant bg-surface-container px-3 py-2 font-body text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      value={editing.prompt}
                      onChange={e => setEditing({ ...editing, prompt: e.target.value })}
                      rows={2}
                      placeholder="Enter prompt text..."
                      autoFocus
                    />
                  </td>
                  <td className="px-6 py-3">
                    <input
                      type="number"
                      min="1"
                      className="w-full rounded-lg border border-outline-variant bg-surface-container px-3 py-2 text-right font-body text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      value={editing.responseTarget}
                      onChange={e => setEditing({ ...editing, responseTarget: parseInt(e.target.value) || 0 })}
                    />
                  </td>
                  <td className="px-6 py-3 text-right font-body text-sm text-on-surface-variant">0</td>
                  <td className="px-6 py-3 text-right">
                    <span className="rounded-full bg-error-container px-2 py-0.5 font-label text-xs font-bold text-on-error-container">0%</span>
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={handleSaveNew}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary-container"
                        title="Save"
                      >
                        <span className="material-symbols-outlined text-[18px]">check</span>
                      </button>
                      <button
                        onClick={handleCancelAdd}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high"
                        title="Cancel"
                      >
                        <span className="material-symbols-outlined text-[18px]">close</span>
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      {error && (
        <div className="rounded-2xl bg-error-container px-4 py-3 font-body text-sm text-on-error-container">
          {error}
        </div>
      )}

      {deleteConfirm && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={handleCancelDelete}
          />
          <div
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_24px_48px_rgba(25,28,30,0.24)]"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error-container">
                <span className="material-symbols-outlined text-[20px] text-on-error-container">delete</span>
              </div>
              <div>
                <div className="font-label text-sm font-bold text-on-surface">Remove prompt?</div>
                <div className="font-body text-xs text-on-surface-variant">
                  This action cannot be undone.
                </div>
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={handleCancelDelete}
                className="flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2.5 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="flex-1 rounded-xl bg-error-container px-4 py-2.5 font-label text-sm font-semibold text-on-error-container transition-colors hover:opacity-90"
              >
                Remove
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
