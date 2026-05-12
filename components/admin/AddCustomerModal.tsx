"use client";

import { useState } from "react";

interface AddCustomerModalProps {
  onAdd: (data: { email: string; password: string; companyName: string }) => Promise<void>;
  onClose: () => void;
}

export default function AddCustomerModal({ onAdd, onClose }: AddCustomerModalProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = email && password;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await onAdd({ email, password, companyName });
      onClose();
    } catch (err: any) {
      if (err.message === "email_exists") {
        setError("A customer with this email already exists.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

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
            Add Customer
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-outline transition-colors hover:bg-surface-container-high"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block font-label text-sm font-bold text-on-surface">
              Company Name
            </label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme AI"
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
          </div>

          <div>
            <label className="block font-label text-sm font-bold text-on-surface">
              Email <span className="text-error">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="acme@example.com"
              required
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
          </div>

          <div>
            <label className="block font-label text-sm font-bold text-on-surface">
              Password <span className="text-error">*</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="mt-1 w-full rounded-lg border-none bg-surface-container-highest px-4 py-3 font-body text-sm text-on-surface placeholder-on-surface-variant/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-error-container px-4 py-3 font-label text-sm font-semibold text-on-error-container">
              {error}
            </div>
          )}

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
              disabled={!canSubmit || submitting}
              className="rounded-full bg-primary px-6 py-2.5 font-label text-sm font-semibold text-on-primary shadow-[0_4px_16px_rgba(0,109,61,0.2)] transition-opacity hover:opacity-90 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? "Adding..." : "Add Customer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
