"use client";

interface SubmitButtonProps {
  label: string;
  icon?: string;
  id?: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  /** The button's accessible name while loading, when the dots replace the label. */
  loadingLabel?: string;
}

/**
 * The app's primary full-width action. While `loading`, it is disabled and
 * aria-busy, and `loadingLabel` stands in for the label the dots replace.
 */
export default function SubmitButton({
  label,
  icon = "arrow_forward",
  id,
  onClick,
  disabled = false,
  loading = false,
  loadingLabel = "Loading",
}: SubmitButtonProps) {
  return (
    <button
      type="button"
      id={id}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
      className="flex h-16 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-all duration-200 hover:shadow-[0_12px_32px_rgba(0,109,61,0.3)] active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? (
        <>
          <span className="sr-only">{loadingLabel}</span>
          <LoadingDots />
        </>
      ) : (
        <>
          {label}
          <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
            {icon}
          </span>
        </>
      )}
    </button>
  );
}

/** Decorative progress dots; the button's loading label carries the meaning. */
function LoadingDots() {
  return (
    <span className="flex gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-white motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}
