"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface DeleteCustomerButtonProps {
  customerId: string;
  companyName: string | null;
}

export default function DeleteCustomerButton({ customerId, companyName }: DeleteCustomerButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${customerId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to delete customer.");
        setDeleting(false);
        return;
      }
      router.push("/admin/customers");
      router.refresh();
    } catch {
      setError("Network error.");
      setDeleting(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
          setError(null);
        }}
        className="flex items-center gap-1 rounded-full bg-error-container px-3 py-1.5 font-label text-xs font-bold text-on-error-container transition-opacity hover:opacity-90"
      >
        <span className="material-symbols-outlined text-[16px]">delete</span>
        Delete customer
      </button>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={() => {
          if (!deleting) setConfirming(false);
        }}
      />
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_24px_48px_rgba(25,28,30,0.24)]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error-container">
            <span className="material-symbols-outlined text-[20px] text-on-error-container">delete</span>
          </div>
          <div>
            <div className="font-label text-sm font-bold text-on-surface">Delete customer?</div>
            <div className="font-body text-xs text-on-surface-variant">
              {companyName ?? "This customer"} and all of their campaigns and tasks will be
              permanently removed.
            </div>
          </div>
        </div>
        {error && (
          <div className="mt-4 rounded-lg bg-error-container px-3 py-2 font-body text-xs text-on-error-container">
            {error}
          </div>
        )}
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={() => {
              if (!deleting) setConfirming(false);
            }}
            disabled={deleting}
            className="flex-1 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2.5 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={deleting}
            className="flex-1 rounded-xl bg-error px-4 py-2.5 font-label text-sm font-semibold text-on-error transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </>
  );
}
