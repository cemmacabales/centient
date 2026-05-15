"use client";

interface SegmentedControlProps {
  options: string[];
  selected: string | null;
  onChange: (value: string) => void;
  optional?: boolean;
}

export default function SegmentedControl({
  options,
  selected,
  onChange,
  optional = false,
}: SegmentedControlProps) {
  return (
    <div
      className="flex rounded-full bg-surface-container p-1"
      role="group"
      aria-label={optional ? "Optional selection" : "Selection"}
    >
      {options.map((option) => {
        const isSelected = selected === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`flex-1 rounded-full px-3 py-2.5 font-label text-sm font-medium transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
              isSelected
                ? "bg-primary text-on-primary shadow-sm"
                : "text-on-surface-variant hover:bg-surface-container-high"
            }`}
            aria-pressed={isSelected}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}