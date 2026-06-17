import { describe, it, expect, vi, afterEach } from "vitest";
import { recoverMessageAddress } from "viem";
import { isSimulationMode, simulatedAddress, createSimulatedProvider } from "@/lib/simulation";

afterEach(() => vi.unstubAllEnvs());

describe("isSimulationMode", () => {
  it("is true when flag is 1 and NODE_ENV is not production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");
    expect(isSimulationMode()).toBe(true);
  });

  it("is false when the flag is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "");
    expect(isSimulationMode()).toBe(false);
  });

  it("is hard-off in production even with the flag set to 1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");
    expect(isSimulationMode()).toBe(false);
  });
});

describe("simulatedAddress", () => {
  it("derives a lowercase 0x address from the default key", () => {
    const addr = simulatedAddress();
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
    // Default key is Hardhat/Anvil account #0
    expect(addr).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });
});

describe("createSimulatedProvider", () => {
  it("reports MiniPay and returns the simulated address for eth_requestAccounts", async () => {
    const provider = createSimulatedProvider();
    expect(provider.isMiniPay).toBe(true);
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    expect(accounts).toEqual([simulatedAddress()]);
  });

  it("personal_sign produces a signature that recovers to the simulated address", async () => {
    const provider = createSimulatedProvider();
    const message =
      "Centient Labeler Authentication\nWallet: 0xabc\nNonce: nonce123";
    const signature = (await provider.request({
      method: "personal_sign",
      params: [message, simulatedAddress()],
    })) as `0x${string}`;
    const recovered = (
      await recoverMessageAddress({ message, signature })
    ).toLowerCase();
    expect(recovered).toBe(simulatedAddress());
  });
});
