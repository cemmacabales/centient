"use client";

const FORMATS = [
  { label: "JSON", ext: "json", type: "json" },
  { label: "CSV", ext: "csv", type: "csv" },
  { label: "Plain text", ext: "txt", type: "txt" },
];

export default function ExportButton() {
  function download(format: string) {
    window.location.href = `/api/admin/export?format=${format}`;
  }

  return (
    <div className="flex items-center gap-3">
      {FORMATS.map((fmt) => (
        <button
          key={fmt.type}
          onClick={() => download(fmt.type)}
          className="rounded-xl bg-primary px-4 py-2 font-label text-sm font-semibold text-on-primary transition-opacity hover:opacity-90 active:scale-[0.97]"
        >
          {fmt.label}
        </button>
      ))}
    </div>
  );
}
