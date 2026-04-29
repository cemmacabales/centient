"use client";

export default function ExportButton() {
  function download(split: string) {
    const key = prompt("Enter admin password:");
    if (!key) return;
    window.location.href = `/api/admin/export?key=${key}&split=${split}`;
  }

  return (
    <div className="flex items-center gap-3">
      <span className="font-label text-xs font-bold uppercase tracking-[0.2em] text-outline">
        Export Dataset
      </span>
      {["all", "train", "test", "validation"].map((split) => (
        <button
          key={split}
          onClick={() => download(split)}
          className="rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
        >
          {split}.jsonl
        </button>
      ))}
    </div>
  );
}