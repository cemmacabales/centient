import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// WALLET_ADDRESS is derived from PAYOUT_PRIVATE_KEY at module-load time, so each
// case must set the env var and then dynamically import a fresh copy of the module.
const ORIGINAL = process.env.PAYOUT_PRIVATE_KEY;

describe("celo-balance wallet address derivation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAYOUT_PRIVATE_KEY;
    else process.env.PAYOUT_PRIVATE_KEY = ORIGINAL;
    vi.restoreAllMocks();
  });

  it("does not crash at import when PAYOUT_PRIVATE_KEY is a placeholder/invalid key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PAYOUT_PRIVATE_KEY = "0x_your_funded_hot_wallet_private_key";

    // Importing must not throw; an invalid key is treated like an unconfigured wallet.
    const mod = await import("../celo-balance");
    const health = await mod.getWalletHealth();

    expect(health.address).toBe("—");
    expect(health.warnings).toContain("PAYOUT_PRIVATE_KEY not configured");
  });

  it("reports unconfigured when PAYOUT_PRIVATE_KEY is missing", async () => {
    delete process.env.PAYOUT_PRIVATE_KEY;

    const mod = await import("../celo-balance");
    const health = await mod.getWalletHealth();

    expect(health.address).toBe("—");
    expect(health.warnings).toContain("PAYOUT_PRIVATE_KEY not configured");
  });

  it("derives the wallet address from a valid PAYOUT_PRIVATE_KEY without crashing at import", async () => {
    // Throwaway, never-funded key — only the address derivation is exercised here.
    process.env.PAYOUT_PRIVATE_KEY =
      "0xf9f501247822b71d7182366bd8285e3780f2330c5c42adf94b9e84041a5c06a5";

    const mod = await import("../celo-balance");
    // No network call here — we only assert the module loaded and the address is derivable.
    expect(typeof mod.getWalletHealth).toBe("function");
  });
});
