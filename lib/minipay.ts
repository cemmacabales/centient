"use client";

export function isMiniPay(): boolean {
  if (typeof window === "undefined") return false;
  const eth = (window as any).ethereum;
  return !!eth && eth.isMiniPay === true;
}

export async function getWalletAddress(): Promise<string | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  return accounts[0]?.toLowerCase() ?? null;
}
