import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetHealthMonitorSnapshot, mockGetHealthSnapshot, mockGetWalletHealth } = vi.hoisted(
  () => ({
    mockGetHealthMonitorSnapshot: vi.fn(),
    mockGetHealthSnapshot: vi.fn(),
    mockGetWalletHealth: vi.fn(),
  }),
);

vi.mock("@/lib/admin-auth", () => ({ requireRoleForPage: vi.fn() }));
vi.mock("@/lib/admin-data", () => ({
  getHealthSnapshot: mockGetHealthSnapshot,
  isStuckPending: vi.fn(() => false),
}));
vi.mock("@/lib/health-monitor", () => ({
  getHealthMonitorSnapshot: mockGetHealthMonitorSnapshot,
}));
vi.mock("@/lib/stellar/balance", () => ({
  getWalletHealth: mockGetWalletHealth,
}));

import AdminStatusHealthPage from "../page";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetHealthSnapshot.mockResolvedValue({
    pendingSubmissions: 0,
    pendingOldestAt: null,
    failedSubmissions: 3,
    failedLast24h: 3,
    abandonedSubmissions: 0,
    totalTasks: 10,
    totalCampaignTasks: 8,
    totalPlatformGoldTasks: 2,
    totalUsers: 5,
    bannedUsers: 0,
    hotWalletAddress: "GPLATFORM1234567890",
    hotWalletBalance: "5.0000",
    rewardSymbol: "USDC",
    stuckPayoutThresholdMs: 300_000,
    dailyPayoutCapUnits: "2000000000",
    dailyPayoutSpentUnits: "1600000000",
    dailyPayoutRemainingUnits: "400000000",
    dailyPayoutSpentPct: 80,
  });
  const wallet = {
    address: "GPLATFORM1234567890",
    usdcBalance: "5.0000",
    xlmBalance: "6.0000",
    availableXlmBalance: "1.0000",
    numSponsoring: 10,
    sponsoredReserveXlm: "5.0000",
    rewardTokenSymbol: "USDC",
    healthy: false,
    warnings: [],
    pages: ["USDC low", "XLM low"],
    assetStatus: { usdc: "page", xlm: "page" },
    thresholds: { warnUsdc: 50, pageUsdc: 10, warnXlm: 5, pageXlm: 2 },
  };
  mockGetWalletHealth.mockResolvedValue(wallet);
  mockGetHealthMonitorSnapshot.mockResolvedValue({
    checkedAt: "2026-09-08T00:00:00.000Z",
    wallet,
    metrics: {
      payoutCount: 100,
      payoutVolumeUnits: "1000000000",
      failedPayoutCount: 3,
      dailyCapUnits: "2000000000",
      dailySpentUnits: "1600000000",
      dailyCapPercent: 80,
      reserveStatus: "refill_required",
      hotBalanceUnits: "250000000",
      coldBalanceUnits: "2000000000",
      refillDueSince: "2026-09-07T23:29:00.000Z",
    },
    thresholds: {
      payoutWindowMinutes: 60,
      payoutCountThreshold: 100,
      payoutVolumeUnitsThreshold: "1000000000",
      failureWindowMinutes: 15,
      failureCountThreshold: 3,
      capPercentThreshold: 80,
      refillOverdueMinutes: 30,
    },
    alerts: [
      {
        key: "payout-cap",
        severity: "WARN",
        title: "Daily payout cap is approaching",
        lines: ["80% consumed"],
      },
    ],
  });
});

describe("admin status health page", () => {
  it("shows both spendable wallet assets and the active anomaly/refill state", async () => {
    const html = renderToStaticMarkup(await AdminStatusHealthPage());

    expect(html).toContain("5.0000 USDC");
    expect(html).toContain("1.0000 XLM spendable");
    expect(html).toContain("Daily payout cap is approaching");
    expect(html).toContain("80% used");
    expect(html).toContain("Refill required");
    expect(html).toContain("200.0000 USDC reserve");
  });
});
