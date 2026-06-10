import { celoSepolia } from "viem/chains";
import {
  activeChain,
  CELO_MAINNET_CHAIN_PARAMS,
  CELO_SEPOLIA_CHAIN_PARAMS,
} from "./constants";

export function isMetaMask(): boolean {
  if (typeof window === "undefined") return false;
  const eth = (window as any).ethereum;
  return !!eth && eth.isMetaMask === true;
}

export async function connectMetaMask(timeoutMs = 10_000): Promise<string> {
  if (typeof window === "undefined") throw new Error("ssr");
  const eth = (window as any).ethereum;
  
  if (!eth) throw new Error("MetaMask is not installed. Please install it from metamask.io.");
  if (!eth.isMetaMask) throw new Error("MetaMask not detected. Please make sure it's enabled.");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Connection timed out. Please try again.")), timeoutMs),
  );

  const request = eth.request({ method: "eth_requestAccounts" }).then((accounts: unknown) => {
    const list = Array.isArray(accounts) ? accounts : [];
    const account = String(list[0] ?? "").toLowerCase();
    if (!account) throw new Error("No accounts found. Please unlock your wallet.");
    return account;
  });

  return Promise.race([request, timeout]);
}

export async function switchToCelo(): Promise<void> {
  if (typeof window === "undefined") throw new Error("ssr");
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("ethereum_not_present");
  if (!isMetaMask()) throw new Error("metamask_not_present");

  const chainParams = activeChain().id === celoSepolia.id
    ? CELO_SEPOLIA_CHAIN_PARAMS
    : CELO_MAINNET_CHAIN_PARAMS;

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainParams.chainId }],
    });
  } catch (err: any) {
    if (err?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [chainParams],
      });
      return;
    }
    throw err;
  }
}
