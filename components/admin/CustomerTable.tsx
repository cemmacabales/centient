"use client";

import { useState } from "react";

interface Customer {
  id: string;
  email: string;
  companyName: string | null;
  createdAt: string;
  isVerified: boolean;
}

interface CustomerTableProps {
  customers: Customer[];
  onDelete?: (id: string) => void;
}

export default function CustomerTable({ customers, onDelete }: CustomerTableProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleResend(id: string) {
    const res = await fetch(`/api/admin/customers/${id}/resend-verification`, { method: "POST" });
    const body = await res.json();
    if (body.emailDelivered === false) {
      setFeedback({ type: "error", text: body.warning || "Could not resend verification email." });
    } else {
      setFeedback({ type: "success", text: "Verification email sent." });
    }
    setTimeout(() => setFeedback(null), 5000);
  }

  async function handleVerify(id: string) {
    const res = await fetch(`/api/admin/customers/${id}/verify`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setFeedback({ type: "error", text: body.error === "already_verified" ? "Already verified." : "Failed to verify." });
    } else {
      setFeedback({ type: "success", text: "Customer manually verified." });
    }
    setTimeout(() => { setFeedback(null); window.location.reload(); }, 1500);
  }

  if (customers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-3xl border border-outline-variant/40 bg-surface-container-low/60 p-12 text-center">
        <span
          className="material-symbols-outlined text-[48px] text-outline"
          aria-hidden="true"
        >
          group_add
        </span>
        <h3 className="mt-4 font-headline text-lg font-bold text-on-surface">
          No customers yet
        </h3>
        <p className="mt-1 font-body text-sm text-on-surface-variant">
          Add one to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      {feedback && (
        <div
          className={`mb-3 rounded-lg px-4 py-3 font-label text-sm font-semibold ${
            feedback.type === "success"
              ? "bg-green-100 text-green-800"
              : "bg-yellow-100 text-yellow-800"
          }`}
        >
          {feedback.text}
        </div>
      )}
      <div className="overflow-hidden rounded-3xl border border-outline-variant/40 bg-surface-container-lowest shadow-[0_4px_24px_rgba(25,28,30,0.04)]">
      <table className="w-full">
        <thead>
          <tr className="border-b border-outline-variant/30">
            <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
              Company
            </th>
            <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
              Email
            </th>
            <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
              Created
            </th>
            <th className="px-6 py-4 text-left font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
              Verified
            </th>
            <th className="px-6 py-4 text-right font-label text-xs font-bold uppercase tracking-[0.15em] text-outline">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr
              key={c.id}
              className="border-b border-outline-variant/20 last:border-0 transition-colors hover:bg-surface-container-low/40"
            >
              <td className="px-6 py-4 font-body text-sm font-semibold text-on-surface">
                {c.companyName ?? "—"}
              </td>
              <td className="px-6 py-4 font-body text-sm text-on-surface-variant">
                {c.email}
              </td>
              <td className="px-6 py-4 font-body text-sm text-on-surface-variant">
                {new Date(c.createdAt).toLocaleDateString()}
              </td>
              <td className="px-6 py-4">
                {c.isVerified ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 font-label text-xs font-semibold text-green-700">
                    <span className="material-symbols-outlined text-[14px]">check_circle</span>
                    Verified
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-1 font-label text-xs font-semibold text-yellow-700">
                    <span className="material-symbols-outlined text-[14px]">schedule</span>
                    Pending
                  </span>
                )}
              </td>
              <td className="px-6 py-4 text-right">
                {confirmId === c.id ? (
                  <div className="flex items-center justify-end gap-2">
                    <span className="font-body text-xs text-error">
                      Delete?
                    </span>
                    <button
                      onClick={async () => {
                        if (onDelete) {
                          await onDelete(c.id);
                        } else {
                          await fetch(`/api/admin/customers/${c.id}`, { method: "DELETE" });
                        }
                        window.location.reload();
                      }}
                      className="rounded-lg bg-error px-3 py-1.5 font-label text-xs font-bold text-on-error transition-opacity hover:opacity-80"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="rounded-lg bg-surface-container-high px-3 py-1.5 font-label text-xs font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-highest"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-1">
                    {!c.isVerified && (
                      <>
                        <button
                          onClick={() => handleResend(c.id)}
                          className="rounded-full p-2 text-outline transition-colors hover:bg-primary-container hover:text-on-primary-container"
                          aria-label="Resend verification email"
                          title="Resend verification email"
                        >
                          <span className="material-symbols-outlined text-[18px]">mail</span>
                        </button>
                        <button
                          onClick={() => handleVerify(c.id)}
                          className="rounded-full p-2 text-outline transition-colors hover:bg-green-100 hover:text-green-700"
                          aria-label="Mark as verified"
                          title="Mark as verified"
                        >
                          <span className="material-symbols-outlined text-[18px]">check_circle</span>
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => setConfirmId(c.id)}
                      className="rounded-full p-2 text-outline transition-colors hover:bg-error-container hover:text-on-error-container"
                      aria-label="Delete customer"
                    >
                      <span className="material-symbols-outlined text-[20px]">
                        delete
                      </span>
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
