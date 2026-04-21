"use client";

interface EarningsBadgeProps {
  totalEarned: string;
}

export default function EarningsBadge({ totalEarned }: EarningsBadgeProps) {
  return (
    <span className="rounded-full bg-secondary-fixed/20 px-3 py-1 text-sm font-semibold text-secondary">
      ${totalEarned}
    </span>
  );
}
