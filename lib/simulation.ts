import { privateKeyToAccount } from "viem/accounts";

/**
 * Local-dev-only MiniPay simulation gate. Hard-off in production regardless of
 * the flag, so it can never affect a real deploy.
 *
 * NOTE: This module is imported by BOTH the client shim and server code, so it
 * must contain no Node-only imports (no `node:crypto`). It depends only on
 * `viem/accounts` (isomorphic) and `process.env`.
 */
export function isSimulationMode(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_SIMULATE_MINIPAY === "1"
  );
}

// Well-known local dev key (Hardhat/Anvil account #0). Throwaway — no real funds.
// Public so the client shim can read it to sign in-browser.
const DEFAULT_SIM_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const SIMULATED_WALLET_PRIVATE_KEY = (process.env
  .NEXT_PUBLIC_SIMULATED_WALLET_PRIVATE_KEY ?? DEFAULT_SIM_KEY) as `0x${string}`;

export function simulatedAddress(): `0x${string}` {
  return privateKeyToAccount(
    SIMULATED_WALLET_PRIVATE_KEY,
  ).address.toLowerCase() as `0x${string}`;
}
