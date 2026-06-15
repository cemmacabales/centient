"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { formatUnits, parseUnits } from "viem";
import { useRouter } from "next/navigation";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import ExportModal from "@/components/admin/ExportModal";

interface TaskProgress {
  taskId: string;
  prompt: string;
  responseTarget: number;
  responseCount: number;
  pct: number;
  rewardWei?: string;
  majorityAnswer?: string | null;
  agreementScore?: number | null;
  agreementPct?: number | null;
}

interface EditingRow {
  taskId: string | null;
  prompt: string;
  responseTarget: number;
  rewardWei?: string | null;
}

interface CampaignDetailProps {
  campaignId: string;
  campaignName: string;
  defaultResponseTarget: number;
  rewardWei: string;
  pausedAt: string | null;
  ownerEmail: string | null;
  isReadOnly: boolean;
  canManage: boolean;
}

type DeleteConfirm = { taskId: string } | null;
type CampaignDeleteConfirm = boolean;

type UploadJobStatus = "queued" | "processing" | "done" | "failed" | "cancelled";

interface UploadJob {
  id: string;
  campaignId: string;
  fileName: string;
  fileSize: number;
  status: UploadJobStatus;
  totalRows: number;
  processedRows: number;
  upsertedRows: number;
  skippedRows: number;
  errorRows: number;
  chunksCommitted: number;
  chunksTotal: number;
  errorSamples: string[] | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const POLL_INTERVAL_MS = 1500;

export default function CampaignDetail({
  campaignId,
  campaignName: initialCampaignName,
  defaultResponseTarget,
  rewardWei,
  pausedAt: initialPausedAt,
  ownerEmail,
  isReadOnly,
  canManage,
}: CampaignDetailProps) {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [liveJob, setLiveJob] = useState<UploadJob | null>(null);
  const [editing, setEditing] = useState<EditingRow | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm>(null);
  const [campaignDeleteConfirm, setCampaignDeleteConfirm] = useState<CampaignDeleteConfirm>(false);
  const [deletingCampaign, setDeletingCampaign] = useState(false);
  const [deleteCampaignError, setDeleteCampaignError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [campaignRewardEdit, setCampaignRewardEdit] = useState(false);
  const [campaignRewardDisplay, setCampaignRewardDisplay] = useState(() => {
    try { return formatUnits(BigInt(rewardWei), REWARD_TOKEN_DECIMALS); } catch { return "0.05"; }
  });
  const [campaignRewardSaving, setCampaignRewardSaving] = useState(false);
  const [pausedAt, setPausedAt] = useState<string | null>(initialPausedAt);
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState<string>(initialCampaignName);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState<string>(initialCampaignName);
  const [renamingLoading, setRenamingLoading] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"progress" | "agreement">("progress");
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/campaigns/${campaignId}/tasks`);
    if (res.ok) {
      const data = await res.json();
      setTasks(data);
    }
    setLoading(false);
  }, [campaignId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleDismissUpload = useCallback(() => {
    stopPolling();
    setLiveJob(null);
  }, [stopPolling]);

  useEffect(() => {
    fetchTasks();
  }, [campaignId, fetchTasks]);

  useEffect(() => {
    if (!liveJob) return;
    const terminal = liveJob.status === "done" || liveJob.status === "failed" || liveJob.status === "cancelled";
    if (terminal) {
      if (liveJob.status === "done") fetchTasks();
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/admin/campaigns/${campaignId}/upload/${liveJob.id}`);
        if (!res.ok) {
          stopPolling();
          return;
        }
        const next = (await res.json()) as UploadJob;
        setLiveJob(next);
        const isTerminal = next.status === "done" || next.status === "failed" || next.status === "cancelled";
        if (isTerminal) {
          stopPolling();
          if (next.status === "done") fetchTasks();
        }
      } catch {
        stopPolling();
      }
    }, POLL_INTERVAL_MS);

    return () => stopPolling();
  }, [liveJob?.id, liveJob?.status, fetchTasks]);

  useEffect(() => {
    if (liveJob?.status === "done") {
      const timer = setTimeout(() => {
        handleDismissUpload();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [liveJob?.status, handleDismissUpload]);

  async function handleSaveCampaignReward() {
    setCampaignRewardSaving(true);
    try {
      const wei = parseUnits(campaignRewardDisplay.trim(), REWARD_TOKEN_DECIMALS).toString();
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rewardWei: wei }),
      });
      if (!res.ok) {
        setError("Failed to save campaign reward");
        setCampaignRewardDisplay(() => {
          try { return formatUnits(BigInt(rewardWei), REWARD_TOKEN_DECIMALS); } catch { return "0.05"; }
        });
      } else {
        setCampaignRewardEdit(false);
      }
    } catch {
      setError("Invalid reward amount");
      setCampaignRewardDisplay(() => {
        try { return formatUnits(BigInt(rewardWei), REWARD_TOKEN_DECIMALS); } catch { return "0.05"; }
      });
    }
    setCampaignRewardSaving(false);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setLiveJob(null);

    const formData = new FormData();
    formData.append("file", file);

    let res: Response;
    try {
      res = await fetch(`/api/admin/campaigns/${campaignId}/upload`, {
        method: "POST",
        body: formData,
      });
    } catch {
      setError("Upload failed — could not reach server");
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    if (res.status === 202) {
      const accepted = await res.json();
      setLiveJob({
        ...accepted,
        processedRows: 0,
        upsertedRows: 0,
        skippedRows: 0,
        errorRows: 0,
        chunksCommitted: 0,
        chunksTotal: Math.ceil(accepted.totalRows / 500),
        errorSamples: null,
        lastError: null,
        startedAt: null,
        completedAt: null,
        updatedAt: accepted.createdAt,
      } as UploadJob);
    } else if (res.ok) {
      const result = await res.json();
      setError(
        result.errors?.length
          ? `Upload parsed 0 rows. ${result.skipped} row(s) skipped.`
          : "Upload contained no valid rows."
      );
      fetchTasks();
    } else if (res.status === 413) {
      setError("File is too large (max 5 MB).");
    } else if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      const code = body?.error;
      const message =
        code === "gold_columns_not_allowed"
          ? "CSV contains gold columns. Strip isGold/goldAnswer before uploading."
          : code === "invalid_file_type"
          ? "Only .csv files are supported."
          : code === "missing_file"
          ? "Choose a CSV file to upload."
          : "Upload request was rejected by the server.";
      setError(message);
    } else {
      setError("Upload failed. Try again or contact support.");
    }

    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleRetry() {
    if (!liveJob) return;
    const res = await fetch(`/api/admin/campaigns/${campaignId}/upload/${liveJob.id}/retry`, {
      method: "POST",
    });
    if (!res.ok) {
      setError("Could not retry upload");
      return;
    }
    setLiveJob({
      ...liveJob,
      status: "queued",
      processedRows: 0,
      upsertedRows: 0,
      skippedRows: 0,
      errorRows: 0,
      chunksCommitted: 0,
      lastError: null,
      completedAt: null,
      startedAt: null,
    });
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

  function handleStartRename() {
    setRenameValue(campaignName);
    setRenameError(null);
    setRenaming(true);
  }

  function handleCancelRename() {
    setRenaming(false);
    setRenameError(null);
    setRenameValue(campaignName);
  }

  async function handleSaveRename() {
    const next = renameValue.trim();
    if (next.length < 1 || next.length > 200) {
      setRenameError("Name must be between 1 and 200 characters.");
      return;
    }
    if (next === campaignName) {
      setRenaming(false);
      return;
    }

    const previous = campaignName;
    setRenamingLoading(true);
    setRenameError(null);
    setCampaignName(next);
    setRenaming(false);

    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });

      if (!res.ok) {
        setCampaignName(previous);
        const body = await res.json().catch(() => ({}));
        setRenameError(
          body.error === "invalid_name"
            ? "Name must be between 1 and 200 characters."
            : "Failed to rename campaign.",
        );
      }
    } catch {
      setCampaignName(previous);
      setRenameError("Network error.");
    } finally {
      setRenamingLoading(false);
    }
  }

  async function handleConfirmDeleteCampaign() {
    setDeletingCampaign(true);
    setDeleteCampaignError(null);
    try {
      const res = await fetch(`/api/admin/campaigns/${campaignId}`, { method: "DELETE" });
      if (res.status === 204) {
        setCampaignDeleteConfirm(false);
        router.push("/admin/campaigns");
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (body.error === "has_submissions") {
        setDeleteCampaignError(
          `Cannot delete: ${body.count} submissions reference this campaign. Pause it instead.`,
        );
      } else {
        setDeleteCampaignError(body.error ?? "Failed to delete campaign.");
      }
      setDeletingCampaign(false);
    } catch {
      setDeleteCampaignError("Network error.");
      setDeletingCampaign(false);
    }
  }

  function handleEdit(task: TaskProgress) {
    setEditing({ taskId: task.taskId, prompt: task.prompt, responseTarget: task.responseTarget, rewardWei: task.rewardWei ?? null });
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

    const body: Record<string, unknown> = {
      prompt: editing.prompt.trim(),
      responseTarget: editing.responseTarget,
    };
    if (editing.rewardWei !== undefined) {
      body.rewardWei = editing.rewardWei;
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
      body: JSON.stringify(body),
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
    setEditing({ taskId: null, prompt: "", responseTarget: defaultResponseTarget, rewardWei: null });
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

    const body: Record<string, unknown> = {
      prompt: editing.prompt.trim(),
      responseTarget: editing.responseTarget,
    };
    if (editing.rewardWei !== undefined && editing.rewardWei !== null) {
      body.rewardWei = editing.rewardWei;
    }

    const res = await fetch(`/api/admin/campaigns/${campaignId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  const sorted = [...tasks].sort((a, b) => {
    if (sortBy === "agreement") {
      if (a.agreementPct == null && b.agreementPct == null) return 0;
      if (a.agreementPct == null) return 1;
      if (b.agreementPct == null) return -1;
      return a.agreementPct - b.agreementPct;
    }
    return a.pct - b.pct;
  });

  const completedTasks = tasks.filter((t) => t.agreementScore != null);
  const avgAgreement = completedTasks.length > 0
    ? Math.round(completedTasks.reduce((sum, t) => sum + (t.agreementPct ?? 0), 0) / completedTasks.length)
    : null;

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
        {renaming ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={200}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveRename();
                if (e.key === "Escape") handleCancelRename();
              }}
              className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-1.5 font-headline text-2xl font-extrabold text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={handleSaveRename}
              disabled={renamingLoading}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary-container disabled:opacity-50"
              title="Save name"
              aria-label="Save name"
            >
              <span className="material-symbols-outlined text-[20px]">check</span>
            </button>
            <button
              type="button"
              onClick={handleCancelRename}
              disabled={renamingLoading}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-50"
              title="Cancel"
              aria-label="Cancel rename"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
              {campaignName}
            </h1>
            {canManage && (
              <button
                type="button"
                onClick={handleStartRename}
                disabled={renamingLoading}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-50"
                title="Rename campaign"
                aria-label="Rename campaign"
              >
                <span className="material-symbols-outlined text-[18px]">edit</span>
              </button>
            )}
          </div>
        )}
        <span className="font-body text-sm text-on-surface-variant">
          Target: {defaultResponseTarget} responses per task
        </span>
        {campaignRewardEdit ? (
          <span className="flex items-center gap-1">
            <input
              type="text"
              inputMode="decimal"
              value={campaignRewardDisplay}
              onChange={(e) => setCampaignRewardDisplay(e.target.value)}
              className="w-20 rounded-lg border border-outline-variant bg-surface-container px-2 py-1 text-right font-body text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              disabled={campaignRewardSaving}
              autoFocus
            />
            <button
              onClick={handleSaveCampaignReward}
              disabled={campaignRewardSaving}
              className="flex h-6 w-6 items-center justify-center rounded text-primary transition-colors hover:bg-primary-container"
              title="Save"
            >
              <span className="material-symbols-outlined text-[16px]">check</span>
            </button>
            <button
              onClick={() => {
                setCampaignRewardEdit(false);
                try { setCampaignRewardDisplay(formatUnits(BigInt(rewardWei), REWARD_TOKEN_DECIMALS)); } catch { setCampaignRewardDisplay("0.05"); }
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant transition-colors hover:bg-surface-container-high"
              title="Cancel"
            >
              <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1 font-body text-sm text-on-surface-variant">
            Reward: {campaignRewardDisplay} {REWARD_TOKEN_SYMBOL} / task
            <button
              onClick={() => setCampaignRewardEdit(true)}
              className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant transition-colors hover:bg-surface-container-high"
              title="Edit reward"
            >
              <span className="material-symbols-outlined text-[14px]">edit</span>
            </button>
          </span>
        )}
        {pausedAt && (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-3 py-1 font-label text-xs font-bold text-yellow-800">
            <span className="material-symbols-outlined text-[14px]">pause</span>
            paused since {new Date(pausedAt).toLocaleDateString("en-US")}
          </span>
        )}
      </div>

      {renameError && (
        <div className="rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container">
          {renameError}
        </div>
      )}

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

        {canManage && (
          <button
            type="button"
            onClick={() => {
              setDeleteCampaignError(null);
              setCampaignDeleteConfirm(true);
            }}
            className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2 font-label text-sm font-semibold text-error transition-colors hover:bg-error-container hover:text-on-error-container"
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            Delete
          </button>
        )}

        <ExportModal campaignId={campaignId} />
      </div>

      {liveJob && <UploadStatusCard job={liveJob} onRetry={handleRetry} onDismiss={handleDismissUpload} />}

      <section className="rounded-3xl border border-outline-variant/40 bg-surface-container-lowest shadow-[0_4px_24px_rgba(25,28,30,0.04)]">
        <div className="flex items-center justify-between border-b border-outline-variant/30 px-6 py-4">
          <div className="flex items-center gap-4">
            <h2 className="font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
              Task Progress
              {sortBy === "progress" ? " — sorted by lowest completion first" : " — sorted by lowest agreement first"}
            </h2>
            {avgAgreement != null && (
              <span className={`rounded-full px-2 py-0.5 font-label text-xs font-bold ${
                avgAgreement >= 70 ? "bg-primary-container text-on-primary-container"
                : avgAgreement >= 50 ? "bg-tertiary-container text-on-tertiary-container"
                : "bg-error-container text-on-error-container"
              }`}>
                Avg Agreement: {avgAgreement}%
              </span>
            )}
            <button
              type="button"
              onClick={() => setSortBy(sortBy === "progress" ? "agreement" : "progress")}
              className="flex items-center gap-1 rounded-lg border border-outline-variant px-2 py-1 font-label text-xs text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">sort</span>
              Sort by {sortBy === "progress" ? "agreement" : "progress"}
            </button>
          </div>
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
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline w-20">
                  Reward
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
                <th className="px-6 py-3 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline w-24">
                  Agreement
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
                          type="text"
                          inputMode="decimal"
                          placeholder="Inherit"
                          className="w-full rounded-lg border border-outline-variant bg-surface-container px-2 py-2 text-right font-body text-xs text-on-surface placeholder-on-surface-variant/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                          value={editing.rewardWei !== undefined && editing.rewardWei !== null ? (() => { try { return formatUnits(BigInt(editing.rewardWei), REWARD_TOKEN_DECIMALS); } catch { return ""; } })() : ""}
                          onChange={e => {
                            const v = e.target.value.trim();
                            if (v === "") {
                              setEditing({ ...editing, rewardWei: null });
                            } else {
                              try { setEditing({ ...editing, rewardWei: parseUnits(v, REWARD_TOKEN_DECIMALS).toString() }); } catch {}
                            }
                          }}
                        />
                      ) : (
                        <span className="block text-right font-body text-sm text-on-surface-variant">
                          {(() => { try { return formatUnits(BigInt(t.rewardWei || "0"), REWARD_TOKEN_DECIMALS); } catch { return "—"; } })()}
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
                    <td className="px-6 py-3 text-right">
                      {t.agreementPct != null ? (
                        <span
                          className={`rounded-full px-2 py-0.5 font-label text-xs font-bold ${
                            t.agreementPct >= 70
                              ? "bg-primary-container text-on-primary-container"
                              : t.agreementPct >= 50
                              ? "bg-tertiary-container text-on-tertiary-container"
                              : "bg-error-container text-on-error-container"
                          }`}
                          title={t.majorityAnswer ? `Majority: ${t.majorityAnswer}` : undefined}
                        >
                          {t.agreementPct}% {t.majorityAnswer ? `(${t.majorityAnswer})` : ""}
                        </span>
                      ) : (
                        <span className="text-on-surface-variant/40 font-body text-sm">—</span>
                      )}
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
                      type="text"
                      inputMode="decimal"
                      placeholder="Inherit"
                      className="w-full rounded-lg border border-outline-variant bg-surface-container px-2 py-2 text-right font-body text-xs text-on-surface placeholder-on-surface-variant/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      value={editing.rewardWei !== undefined && editing.rewardWei !== null ? (() => { try { return formatUnits(BigInt(editing.rewardWei), REWARD_TOKEN_DECIMALS); } catch { return ""; } })() : ""}
                      onChange={e => {
                        const v = e.target.value.trim();
                        if (v === "") {
                          setEditing({ ...editing, rewardWei: null });
                        } else {
                          try { setEditing({ ...editing, rewardWei: parseUnits(v, REWARD_TOKEN_DECIMALS).toString() }); } catch {}
                        }
                      }}
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
                  <td className="px-6 py-3 text-right">
                    <span className="text-on-surface-variant/40 font-body text-sm">—</span>
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

      {campaignDeleteConfirm && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              if (!deletingCampaign) {
                setCampaignDeleteConfirm(false);
                setDeleteCampaignError(null);
              }
            }}
          />
          <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_24px_48px_rgba(25,28,30,0.24)]">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error-container">
                <span className="material-symbols-outlined text-[20px] text-on-error-container">delete</span>
              </div>
              <div>
                <div className="font-label text-sm font-bold text-on-surface">Delete campaign?</div>
                <div className="font-body text-xs text-on-surface-variant">
                  All tasks in <span className="font-semibold">{campaignName}</span> will be
                  removed. Submissions already collected will block the delete — pause instead.
                </div>
              </div>
            </div>
            {deleteCampaignError && (
              <div className="mt-4 rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container">
                {deleteCampaignError}
              </div>
            )}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  if (!deletingCampaign) {
                    setCampaignDeleteConfirm(false);
                    setDeleteCampaignError(null);
                  }
                }}
                disabled={deletingCampaign}
                className="flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2.5 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteCampaign}
                disabled={deletingCampaign}
                className="flex-1 rounded-xl bg-error px-4 py-2.5 font-label text-sm font-semibold text-on-error transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deletingCampaign ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UploadStatusCard({
  job,
  onRetry,
  onDismiss,
}: {
  job: UploadJob;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const pct = job.totalRows > 0 ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100)) : 0;
  const isTerminal = job.status === "done" || job.status === "failed" || job.status === "cancelled";

  const icon =
    job.status === "done" ? "check_circle" : job.status === "failed" ? "error" : "progress_activity";
  const iconColor =
    job.status === "done"
      ? "text-primary"
      : job.status === "failed"
      ? "text-on-error-container"
      : "text-on-surface-variant";

  const title =
    job.status === "done"
      ? "Import complete"
      : job.status === "failed"
      ? "Import failed"
      : job.status === "cancelled"
      ? "Import cancelled"
      : job.status === "queued"
      ? "Queued for processing"
      : "Processing CSV";

  return (
    <div
      className={`rounded-2xl border p-4 ${
        job.status === "failed"
          ? "border-error/40 bg-error-container/30"
          : "border-outline-variant/40 bg-surface-container-lowest"
      }`}
    >
      <div className="flex items-center gap-4">
        <span className={`material-symbols-outlined text-[24px] ${iconColor}`}>{icon}</span>
        <div className="flex-1">
          <div className="font-label text-sm font-bold text-on-surface">{title}</div>
          <div className="font-body text-xs text-on-surface-variant">
            {job.fileName} ·{" "}
            {isTerminal
              ? `${job.upsertedRows.toLocaleString()} upserted · ${job.skippedRows.toLocaleString()} skipped · ${job.errorRows.toLocaleString()} errors`
              : `${job.processedRows.toLocaleString()} / ${job.totalRows.toLocaleString()} rows · ${job.upsertedRows.toLocaleString()} upserted`}
          </div>
        </div>
        {isTerminal && (
          <button
            onClick={onDismiss}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high"
            title="Dismiss"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}
      </div>

      {!isTerminal && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {job.status === "failed" && job.lastError && (
        <div className="mt-3 rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container">
          {job.lastError}
        </div>
      )}

      {(job.errorSamples?.length ?? 0) > 0 && (
        <div className="mt-3 space-y-1">
          {job.errorSamples!.slice(0, 10).map((err, i) => (
            <div
              key={i}
              className="rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container"
            >
              {err}
            </div>
          ))}
        </div>
      )}

      {job.status === "failed" && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={onRetry}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90"
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
            Retry import
          </button>
        </div>
      )}
    </div>
  );
}
