"use client";

export type WalletLoginType = "minipay" | "metamask" | "sim";

interface WalletLoginButtonProps {
  type: WalletLoginType;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

const COPY: Record<WalletLoginType, { default: string; loading: string; icon: string }> = {
  minipay: {
    default: "Login with MiniPay",
    loading: "Connecting MiniPay…",
    icon: "account_balance_wallet",
  },
  metamask: {
    default: "Login with MetaMask",
    loading: "Connecting MetaMask…",
    icon: "extension",
  },
  sim: {
    default: "Simulate MiniPay login",
    loading: "Simulating…",
    icon: "science",
  },
};

export default function WalletLoginButton({
  type,
  onClick,
  loading = false,
  disabled = false,
}: WalletLoginButtonProps) {
  const c = COPY[type];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="flex h-14 w-full max-w-xs items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
        {c.icon}
      </span>
      {loading ? c.loading : c.default}
    </button>
  );
}
