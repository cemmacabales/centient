"use client";

import { useEffect } from "react";

/** `progress` is the XP loop's (#201): indigo, never an error. */
export type ToastKind = "error" | "info" | "success" | "progress";

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
  /** A short note on the right, such as the streak beside "Daily goal met". */
  detail?: string;
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
  const isSuccess = toast.kind === "success";
  const isProgress = toast.kind === "progress";

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
            : isSuccess
            ? "bg-primary-container text-on-primary-container"
            : isProgress
            ? "items-center bg-tertiary text-on-tertiary shadow-[0_10px_24px_-8px_rgba(73,75,214,0.55)]"
            : "bg-surface-container-highest text-on-surface"
        }`}
      >
        <span
          className={`material-symbols-outlined ${isProgress ? "text-[22px]" : "text-[20px]"}`}
          style={isProgress ? undefined : { fontVariationSettings: "'FILL' 1" }}
          aria-hidden="true"
        >
          {isError ? "error" : isSuccess ? "check_circle" : isProgress ? "today" : "info"}
        </span>
        <p className={`font-body text-sm leading-relaxed ${isProgress ? "font-bold" : ""}`}>{toast.message}</p>
        {toast.detail && (
          <span className={`whitespace-nowrap font-body text-[13px] ${isProgress ? "text-tertiary-fixed" : "opacity-80"}`}>
            {toast.detail}
          </span>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`ml-2 rounded-full p-1 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 ${
            isProgress
              ? "hover:bg-on-tertiary/15 focus-visible:ring-on-tertiary focus-visible:ring-offset-tertiary"
              : "hover:bg-on-surface/10 focus-visible:ring-primary focus-visible:ring-offset-surface"
          }`}
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            close
          </span>
        </button>
      </div>
    </div>
  );
}
