"use client";

import { useEffect } from "react";

export type ToastKind = "error" | "info";

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastProps {
  toast: ToastMessage | null;
  onDismiss: () => void;
  durationMs?: number;
}

export default function Toast({ toast, onDismiss, durationMs = 4000 }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(handle);
  }, [toast, onDismiss, durationMs]);

  if (!toast) return null;

  const isError = toast.kind === "error";

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4"
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      <div
        key={toast.id}
        className={`pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-[0_8px_24px_rgba(25,28,30,0.08)] motion-safe:animate-[centient-toast-in_200ms_ease-out] ${
          isError
            ? "bg-error-container text-on-error-container"
            : "bg-surface-container-highest text-on-surface"
        }`}
      >
        <span
          className="material-symbols-outlined text-[20px]"
          style={{ fontVariationSettings: "'FILL' 1" }}
          aria-hidden="true"
        >
          {isError ? "error" : "info"}
        </span>
        <p className="font-body text-sm leading-relaxed">{toast.message}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ml-2 rounded-full p-1 transition-colors hover:bg-on-surface/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            close
          </span>
        </button>
      </div>
    </div>
  );
}
