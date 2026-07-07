import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: the status-health / dashboard hot-wallet card must read the pooled
// Stellar platform account (via getWalletHealth) — the correctly-formatted USDC
// float and the G… address — not the legacy Celo/EVM viem `balanceOf` read that
// surfaced a raw 18-decimal value (e.g. "0.00000000005966") and an 0x… address.
const { mockGetWalletHealth } = vi.hoisted(() => ({
  mockGetWalletHealth: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/stellar/balance", () => ({
  getWalletHealth: mockGetWalletHealth,
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    submission: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _sum: { payoutAmountUnits: 0n } })),
    },
    task: { count: vi.fn(async () => 0) },
    user: { count: vi.fn(async () => 0) },
  },
}));

import { getHealthSnapshot, getDashboardTotals } from "@/lib/admin-data";

describe("admin hot-wallet card is sourced from Stellar, not the legacy EVM wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure the legacy viem path can't accidentally satisfy the assertion.
    delete process.env.PAYOUT_PRIVATE_KEY;
    mockGetWalletHealth.mockResolvedValue({
      address: "GABCDE1234567890STELLARPLATFORMACCOUNTXYZ",
      usdcBalance: "45.0000",
    });
  });

  it("getHealthSnapshot surfaces the Stellar address and USDC float", async () => {
    const snap = await getHealthSnapshot();
    expect(snap.hotWalletAddress).toBe("GABCDE1234567890STELLARPLATFORMACCOUNTXYZ");
    expect(snap.hotWalletBalance).toBe("45.0000");
  });

  it("getDashboardTotals surfaces the Stellar address and USDC float", async () => {
    const totals = await getDashboardTotals();
    expect(totals.hotWalletAddress).toBe("GABCDE1234567890STELLARPLATFORMACCOUNTXYZ");
    expect(totals.hotWalletBalance).toBe("45.0000");
  });

  it("passes through the '—' sentinels when the platform account is unavailable", async () => {
    mockGetWalletHealth.mockResolvedValue({ address: "—", usdcBalance: "—" });
    const snap = await getHealthSnapshot();
    expect(snap.hotWalletAddress).toBe("—");
    expect(snap.hotWalletBalance).toBe("—");
  });
});
