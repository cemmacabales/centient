"use client";

import { useState } from "react";
import { toast } from "sonner";

interface Props {
  submissionId: string;
  currentStatus: string;
  onSuccess?: () => void;
}

export default function RetryPayoutButton({ submissionId, currentStatus, onSuccess }: Props) {
  const [pending, setPending] = useState(false);

  if (currentStatus !== "failed" && currentStatus !== "abandoned") {
    return null;
  }

  const handleRetry = async () => {
    if (
      !confirm("Are you sure you want to force a payout retry for this submission?")
    ) {
      return;
    }

    setPending(true);
    const loadingToast = toast.loading("Retrying payout…");
    try {
      const res = await fetch(`/api/admin/submissions/${submissionId}/retry`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Retry request failed");
      }
      toast.success("Payout retry triggered successfully.", { id: loadingToast });
      if (onSuccess) onSuccess();
    } catch (err: any) {
      toast.error(`Retry error: ${err.message}`, { id: loadingToast });
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      onClick={handleRetry}
      disabled={pending}
      className="inline-flex items-center gap-1 rounded-full border border-outline-variant/50 px-2.5 py-1 font-label text-[10px] font-bold uppercase tracking-wider text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50 transition-colors"
    >
      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
        replay
      </span>
      {pending ? "Retrying…" : "Retry payout"}
    </button>
  );
}
