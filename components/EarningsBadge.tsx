"use client";

interface EarningsBadgeProps {
  totalEarnedCUSD: string;
}

export default function EarningsBadge({ totalEarnedCUSD }: EarningsBadgeProps) {
  return (
    <span className="rounded-full bg-secondary-fixed/20 px-3 py-1 text-sm font-semibold text-secondary">
      ${totalEarnedCUSD}
    </span>
  );
}
