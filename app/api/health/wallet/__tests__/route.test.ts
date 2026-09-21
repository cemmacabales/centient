import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetWalletHealth, mockLiability, mockSponsorPublicKey } = vi.hoisted(() => ({
  mockGetWalletHealth: vi.fn(),
  mockLiability: vi.fn(),
  mockSponsorPublicKey: vi.fn(),
}));

vi.mock("@/lib/stellar/balance", () => ({
  getWalletHealth: mockGetWalletHealth,
}));
vi.mock("@/lib/sponsored-trustline", () => ({
  sponsorshipLiability: mockLiability,
}));
vi.mock("@/lib/stellar/client", () => ({
  sponsorPublicKey: mockSponsorPublicKey,
}));

import { GET } from "../route";

const LIABILITY = {
  outstanding: 1,
  pending: 0,
  reserveUnits: 1,
  byKind: {
    trustline: { confirmed: 1, pending: 0 },
    "account+trustline": { confirmed: 0, pending: 0 },
  },
};

describe("GET /api/health/wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiability.mockResolvedValue(LIABILITY);
    mockSponsorPublicKey.mockReturnValue("GPLATFORM1234567890");
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

  it("serializes unavailable reserve counts as null rather than zero", async () => {
    mockGetWalletHealth.mockResolvedValue({
      address: "GPLATFORM1234567890",
      usdcBalance: "—",
      rewardTokenSymbol: "USDC",
      xlmBalance: "—",
      availableXlmBalance: "—",
      baseReserveXlm: "—",
      minimumBalanceXlm: "—",
      nativeSellingLiabilitiesXlm: "—",
      numSubentries: null,
      numSponsoring: null,
      numSponsored: null,
      sponsoredReserveXlm: "—",
      monitoringStatus: "error",
      assetStatus: { usdc: "unknown", xlm: "unknown" },
      healthy: false,
      warnings: ["Horizon wallet monitoring unavailable"],
      pages: [],
      thresholds: { warnUsdc: 50, pageUsdc: 10, warnXlm: 5, pageXlm: 2 },
    });

    const body = await (await GET()).json();

    expect(body.numSubentries).toBeNull();
    expect(body.numSponsoring).toBeNull();
    expect(body.numSponsored).toBeNull();
    expect(body.monitoringStatus).toBe("error");
    // Without an on-chain count there is nothing to compare the ledger against.
    expect(body.sponsorshipReserveDriftUnits).toBeNull();
  });

  describe("sponsorship liability (#27)", () => {
    it("reports the ledger's outstanding liability beside Horizon's count, and the drift between them", async () => {
      const body = await (await GET()).json();

      expect(body.sponsorshipLiability).toEqual(LIABILITY);
      // numSponsoring 3 on-chain against 1 reserve unit the ledger knows about.
      expect(body.sponsorshipReserveDriftUnits).toBe(2);
    });

    it("reports no drift when sponsorships come from a key other than the monitored account", async () => {
      mockSponsorPublicKey.mockReturnValue("GSEPARATESPONSOR");
      const body = await (await GET()).json();

      expect(body.sponsorshipLiability).toEqual(LIABILITY);
      expect(body.sponsorshipReserveDriftUnits).toBeNull();
    });

    it("keeps serving wallet health when the ledger cannot be read", async () => {
      mockLiability.mockRejectedValue(new Error("db down"));
      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.numSponsoring).toBe(3);
      expect(body.sponsorshipLiability).toBeNull();
      expect(body.sponsorshipReserveDriftUnits).toBeNull();
    });
  });
});
