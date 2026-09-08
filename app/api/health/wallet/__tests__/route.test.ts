import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetWalletHealth } = vi.hoisted(() => ({
  mockGetWalletHealth: vi.fn(),
}));

vi.mock("@/lib/stellar/balance", () => ({
  getWalletHealth: mockGetWalletHealth,
}));

import { GET } from "../route";

describe("GET /api/health/wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWalletHealth.mockResolvedValue({
      address: "GPLATFORM1234567890",
      usdcBalance: "5.0000",
      rewardTokenSymbol: "USDC",
      xlmBalance: "10.0000",
      availableXlmBalance: "6.0000",
      baseReserveXlm: "0.5000",
      minimumBalanceXlm: "3.0000",
      nativeSellingLiabilitiesXlm: "1.0000",
      numSubentries: 2,
      numSponsoring: 3,
      numSponsored: 1,
      sponsoredReserveXlm: "1.5000",
      monitoringStatus: "healthy",
      assetStatus: { usdc: "healthy", xlm: "healthy" },
      healthy: true,
      warnings: [],
      pages: [],
      thresholds: { warnUsdc: 50, pageUsdc: 10, warnXlm: 5, pageXlm: 2 },
    });
  });

  it("returns the complete public wallet health contract", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      address: "GPLATFORM1234567890",
      usdcBalance: "5.0000",
      rewardTokenSymbol: "USDC",
      xlmBalance: "10.0000",
      availableXlmBalance: "6.0000",
      baseReserveXlm: "0.5000",
      minimumBalanceXlm: "3.0000",
      nativeSellingLiabilitiesXlm: "1.0000",
      numSubentries: 2,
      numSponsoring: 3,
      numSponsored: 1,
      sponsoredReserveXlm: "1.5000",
      monitoringStatus: "healthy",
      assetStatus: { usdc: "healthy", xlm: "healthy" },
      healthy: true,
      warnings: [],
      pages: [],
    });
  });
});
