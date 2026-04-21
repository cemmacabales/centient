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

export async function connectMiniPay(timeoutMs = 10_000): Promise<string> {
  if (typeof window === "undefined") throw new Error("ssr");
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("ethereum_not_present");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("connect_timeout")), timeoutMs),
  );
  const request = eth
    .request({ method: "eth_requestAccounts" })
    .then((accounts: string[]) => {
      const addr = accounts[0]?.toLowerCase();
      if (!addr) throw new Error("no_accounts");
      return addr;
    });

  return Promise.race([request, timeout]);
}
