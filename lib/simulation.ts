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

export interface SimulatedProvider {
  isMiniPay: true;
  __sim: true;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Build an injected-wallet shim backed by the local simulated key. Mirrors the
 * subset of the EIP-1193 provider the app actually uses:
 *  - eth_requestAccounts / eth_accounts -> [simulated address]
 *  - personal_sign -> a real local signature (so /api/auth/verify passes)
 *  - chain-switch calls -> no-op
 */
export function createSimulatedProvider(): SimulatedProvider {
  const account = privateKeyToAccount(SIMULATED_WALLET_PRIVATE_KEY);
  const address = account.address.toLowerCase();
  return {
    isMiniPay: true,
    __sim: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [address];
        case "personal_sign": {
          const message = (params?.[0] ?? "") as string;
          return account.signMessage({ message });
        }
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        default:
          return null;
      }
    },
  };
}
