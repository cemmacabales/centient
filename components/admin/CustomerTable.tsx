"use client";

import { useState } from "react";

interface Customer {
  id: string;
  email: string;
  companyName: string | null;
  createdAt: string;
}

interface CustomerTableProps {
  customers: Customer[];
  onDelete?: (id: string) => void;
}

export default function CustomerTable({ customers, onDelete }: CustomerTableProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
                  <button
                    onClick={() => setConfirmId(c.id)}
                    className="rounded-full p-2 text-outline transition-colors hover:bg-error-container hover:text-on-error-container"
                    aria-label="Delete customer"
                  >
                    <span className="material-symbols-outlined text-[20px]">
                      delete
                    </span>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
