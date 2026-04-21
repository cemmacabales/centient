"use client";

import { truncateAddress } from "@/lib/wallet";

interface WalletChipProps {
  address: string | null;
}

export default function WalletChip({ address }: WalletChipProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-surface-container-lowest px-3 py-1.5 shadow-[0_4px_12px_rgba(25,28,30,0.03)]">
      <span
        className="material-symbols-outlined text-[16px] text-outline"
        aria-hidden="true"
      >
        account_balance_wallet
      </span>
      <span className="font-mono text-xs font-medium text-on-surface-variant">
        {truncateAddress(address)}
      </span>
    </div>
  );
}
