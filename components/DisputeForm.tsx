"use client";

import { useState } from "react";

interface DisputeFormProps {
  walletAddress: string;
  onDone?: () => void;
}

export default function DisputeForm({ walletAddress, onDone }: DisputeFormProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"success" | "duplicate" | "error" | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/me/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setResult("success");
        onDone?.();
      } else if (res.status === 409) {
        setResult("duplicate");
      } else {
        setResult("error");
        setErrorMsg(data.message ?? "Something went wrong. Please try again.");
      }
    } catch {
      setResult("error");
      setErrorMsg("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result === "success") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface-container-low p-6 text-center">
        <span
          className="material-symbols-outlined text-[40px] text-secondary"
          style={{ fontVariationSettings: "'FILL' 1" }}
          aria-hidden="true"
        >
          check_circle
        </span>
        <p className="font-headline text-base font-bold text-on-surface">Appeal submitted</p>
        <p className="font-body text-sm text-on-surface-variant">
          We&apos;ll review your case and get back to you. This usually takes 1-2 business days.
        </p>
      </div>
    );
  }

  if (result === "duplicate") {
    return (
      <div className="rounded-2xl bg-surface-container-low p-6 text-center">
        <p className="font-headline text-base font-bold text-on-surface">Appeal already submitted</p>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          You already have an open appeal. We will review it shortly.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="rounded-2xl bg-surface-container-low p-4">
        <div className="font-label text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
          Wallet
        </div>
        <div className="mt-1 font-mono text-sm text-on-surface-variant break-all">
          {walletAddress}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="dispute-reason"
          className="font-label text-xs font-semibold text-on-surface"
        >
          Describe your situation
        </label>
        <textarea
          id="dispute-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={5}
          maxLength={2000}
          placeholder="Explain why you believe your account was paused incorrectly…"
          className="w-full rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 font-body text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          required
          minLength={10}
        />
        <div className="flex justify-end font-label text-[10px] text-on-surface-variant">
          {reason.length} / 2000
        </div>
      </div>

      {result === "error" && (
        <p className="rounded-xl bg-error-container px-4 py-2 font-body text-sm text-on-error-container">
          {errorMsg}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || reason.trim().length < 10}
        className="w-full rounded-xl bg-primary py-3 font-label text-sm font-bold text-on-primary transition-opacity disabled:opacity-40 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        {submitting ? "Submitting…" : "Submit appeal"}
      </button>
    </form>
  );
}
