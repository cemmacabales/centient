import { describe, it, expect } from "vitest";
import { checkWalletRateLimit, takeRateLimit } from "@/lib/rate-limit";

// Exercises the REAL raw SQL against the test database (the submit-route tests
// mock @/lib/rate-limit, so this is the only coverage of the actual queries).
function randomWallet(): string {
  const hex = Array.from({ length: 40 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `0x${hex}`;
}

describe("checkWalletRateLimit (real SQL)", () => {
  it("allows the first hit and blocks a second within the window", async () => {
    const wallet = randomWallet();
    expect(await checkWalletRateLimit(wallet)).toBe(false);
    expect(await checkWalletRateLimit(wallet)).toBe(true);
  });
});

describe("takeRateLimit (real SQL)", () => {
  it("allows a burst of `max` requests, then refuses with the seconds until the oldest expires", async () => {
    const key = `burst:${randomWallet()}`;
    const limit = { max: 3, windowMs: 60_000 };
    for (let i = 0; i < limit.max; i++) {
      expect(await takeRateLimit(key, limit)).toEqual({ limited: false });
    }

    const refused = await takeRateLimit(key, limit);

    expect(refused.limited).toBe(true);
    if (!refused.limited) return;
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("does not count a refused request, so the key frees up when the window passes", async () => {
    const key = `burst:${randomWallet()}`;
    const limit = { max: 1, windowMs: 1_000 };
    expect((await takeRateLimit(key, limit)).limited).toBe(false);
    expect((await takeRateLimit(key, limit)).limited).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect((await takeRateLimit(key, limit)).limited).toBe(false);
  });
});
