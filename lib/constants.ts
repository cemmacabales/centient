import type { Chain } from "viem";
import { celo, celoSepolia } from "viem/chains";

const toHex = (id: number) => `0x${id.toString(16)}`;

export const CELO_MAINNET = {
  id: celo.id,
  name: "Celo",
  rpcUrl: "https://forno.celo.org",
  explorer: "https://celoscan.io",
};

export const CELO_MAINNET_CHAIN_PARAMS = {
  chainId: toHex(celo.id),
  chainName: "Celo",
  nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 },
  rpcUrls: ["https://forno.celo.org"],
  blockExplorerUrls: ["https://celoscan.io"],
} as const;

export const CELO_SEPOLIA = {
  id: celoSepolia.id,
  name: "Celo Sepolia",
  rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
  explorer: "https://celo-sepolia.blockscout.com",
};

export const CELO_SEPOLIA_CHAIN_PARAMS = {
  chainId: toHex(celoSepolia.id), 
  chainName: "Celo Sepolia",
  nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 },
  rpcUrls: ["https://forno.celo-sepolia.celo-testnet.org"],
  blockExplorerUrls: ["https://celo-sepolia.blockscout.com"],
} as const;

// Reference token addresses (informational — the active reward token is env-driven).
export const CUSD_MAINNET = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const;
export const USDC_MAINNET = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;

const ACTIVE_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? celo.id.toString());

export function activeChain(): Chain {
  return ACTIVE_CHAIN_ID === celoSepolia.id ? celoSepolia : celo;
}

export function activeRpcUrl(): string {
  if (process.env.CELO_RPC_URL) return process.env.CELO_RPC_URL;
  return ACTIVE_CHAIN_ID === celoSepolia.id ? CELO_SEPOLIA.rpcUrl : CELO_MAINNET.rpcUrl;
}

// Server-only — used in payout.
export const REWARD_TOKEN_ADDRESS = (process.env.REWARD_TOKEN_ADDRESS ?? CUSD_MAINNET) as `0x${string}`;

// Public — also used by the client UI.
export const REWARD_AMOUNT = process.env.NEXT_PUBLIC_REWARD_AMOUNT ?? "0.05";
export const REWARD_TOKEN_SYMBOL = process.env.NEXT_PUBLIC_REWARD_TOKEN_SYMBOL ?? "cUSD";
export const REWARD_TOKEN_DECIMALS = Number(process.env.NEXT_PUBLIC_REWARD_TOKEN_DECIMALS ?? "18");
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// Minimum accumulated balance (in wei) a labeler must have before they can
// withdraw, keeping per-withdrawal gas economical. Required + fail-fast like
// PLATFORM_FEE_WEI: an unset/invalid value fails the withdrawal closed (no payout)
// rather than silently defaulting to "no minimum".
export function getMinWithdrawalWei(): bigint {
  const raw = process.env.MIN_WITHDRAWAL_WEI;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(
      "MIN_WITHDRAWAL_WEI env var is required and must be a non-negative integer string"
    );
  }
  return BigInt(raw);
}

export function parseGoldRatio(raw: string | undefined): number {
  const value = Number(raw?.trim() || "0.1");
  if (value < 0 || value > 1 || Number.isNaN(value)) {
    throw new Error(`GOLD_TASK_RATIO must be between 0 and 1, got "${raw}"`);
  }
  return value;
}

export const GOLD_TASK_RATIO = parseGoldRatio(process.env.GOLD_TASK_RATIO);

// Fraud detection: maximum distinct accounts a single wallet can receive
// withdrawals from before being flagged/blocked.
export const MAX_SHARED_WALLET_ACCOUNTS = Number(process.env.MAX_SHARED_WALLET_ACCOUNTS ?? "3");

// Submission payout statuses that represent an *accepted & rewarded* answer:
// legacy per-question on-chain payouts ("sent"/"confirmed") plus the
// accumulate-then-withdraw path ("accrued" — credited to the user's off-chain
// balance). Use this wherever answers are counted toward a task's response
// target or inter-annotator agreement. NOTE: this is deliberately NOT the same
// set used for on-chain *spend* accounting (lib/payout-cap.ts), which must only
// count funds actually moved on-chain and therefore excludes "accrued".
export const REWARDED_STATUSES = ["sent", "confirmed", "accrued"] as const;
