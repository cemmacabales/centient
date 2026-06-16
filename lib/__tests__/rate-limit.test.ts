import { describe, it, expect } from "vitest";
import { checkWalletRateLimit } from "@/lib/rate-limit";

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
