import { describe, it, expect, vi, afterEach } from "vitest";
import { payReward, waitForTx } from "@/lib/payout";

afterEach(() => vi.unstubAllEnvs());

describe("payReward in simulation mode", () => {
  it("returns a well-formed fake tx hash without configuring a payout wallet", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");
    // Real path would throw "PAYOUT_PRIVATE_KEY is not configured"; sim returns first.
    vi.stubEnv("PAYOUT_PRIVATE_KEY", "");

    const hash = await payReward(
      "0x1234567890123456789012345678901234567890",
    );
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("waitForTx in simulation mode", () => {
  it("returns a success receipt without hitting the chain", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SIMULATE_MINIPAY", "1");

    const receipt = await waitForTx(
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    );
    expect(receipt.status).toBe("success");
  });
});
