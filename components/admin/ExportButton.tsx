"use client";

import { useState } from "react";

const FORMATS = [
  { label: "JSON", type: "json", description: "Newline-delimited JSON (.jsonl)", icon: "{ }" },
  { label: "CSV", type: "csv", description: "Comma-separated values (.csv)", icon: "⊞" },
  { label: "Plain text", type: "txt", description: "Human-readable text (.txt)", icon: "☰" },
];

export default function ExportButton() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("json");

  function download() {
    window.location.href = `/api/admin/export?format=${selected}`;
    setOpen(false);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
      >
        Export Dataset
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-surface-container-lowest p-6 shadow-[0_8px_32px_rgba(25,28,30,0.12)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-headline text-xl font-extrabold tracking-tight text-on-surface">
                Export Dataset
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="rounded-full p-2 text-outline transition-colors hover:bg-surface-container-high"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <p className="mt-2 font-body text-sm text-on-surface-variant">
              Choose a format for your export.
            </p>

            <div className="mt-6 space-y-3">
              {FORMATS.map((fmt) => (
                <label
                  key={fmt.type}
                  className={`flex cursor-pointer items-center gap-4 rounded-2xl border p-4 transition-colors ${
                    selected === fmt.type
                      ? "border-primary bg-primary-container/30"
                      : "border-outline-variant/40 bg-surface-container-low/60 hover:bg-surface-container-low"
                  }`}
                >
                  <input
                    type="radio"
                    name="format"
                    value={fmt.type}
                    checked={selected === fmt.type}
                    onChange={() => setSelected(fmt.type)}
                    className="sr-only"
                  />
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-container-highest font-mono text-lg text-primary">
                    {fmt.icon}
                  </span>
                  <div className="flex-1">
                    <div className="font-label text-sm font-bold text-on-surface">
                      {fmt.label}
                    </div>
                    <div className="mt-0.5 font-body text-xs text-on-surface-variant">
                      {fmt.description}
                    </div>
                  </div>
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                      selected === fmt.type
                        ? "border-primary bg-primary"
                        : "border-outline-variant"
                    }`}
                  >
                    {selected === fmt.type && (
                      <span className="block h-2 w-2 rounded-full bg-on-primary" />
                    )}
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setOpen(false)}
                className="rounded-full px-5 py-2.5 font-label text-sm font-semibold text-outline transition-colors hover:bg-surface-container-low"
              >
                Cancel
              </button>
              <button
                onClick={download}
                className="rounded-full bg-primary px-6 py-2.5 font-label text-sm font-semibold text-on-primary shadow-[0_4px_16px_rgba(0,109,61,0.2)] transition-opacity hover:opacity-90 active:scale-[0.97]"
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}