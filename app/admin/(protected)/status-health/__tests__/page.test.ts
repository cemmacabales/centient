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
    xlmBalance: "10.0000",
    availableXlmBalance: "6.0000",
    baseReserveXlm: "0.5000",
    minimumBalanceXlm: "3.0000",
    nativeSellingLiabilitiesXlm: "1.0000",
    numSubentries: 2,
    numSponsoring: 3,
    numSponsored: 1,
    sponsoredReserveXlm: "1.5000",
    rewardTokenSymbol: "USDC",
    monitoringStatus: "healthy" as const,
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
    expect(html).toContain("6.0000 XLM spendable");
    expect(html).toContain("10.0000 XLM total; 3.0000 minimum; 1.0000 liabilities");
    // The thresholds are inclusive (`evaluateStroopThresholds` uses `<=`), so
    // the label must not promise a strict `<`.
    expect(html).toContain("Warning: ≤50 | Page: ≤10");
    expect(html).toContain("Warning: ≤5 | Page: ≤2");
    expect(html).toContain("Daily payout cap is approaching");
    expect(html).toContain("80% used");
    expect(html).toContain("Refill required");
    expect(html).toContain("200.0000 USDC reserve");
  });

  it("shows unavailable payout metrics as em dashes and keeps their source alert visible", async () => {
    mockGetHealthMonitorSnapshot.mockResolvedValueOnce({
      checkedAt: "2026-09-08T00:00:00.000Z",
      wallet: await mockGetWalletHealth(),
      metrics: {
        payoutCount: null,
        payoutVolumeUnits: null,
        failedPayoutCount: null,
        dailyCapUnits: null,
        dailySpentUnits: null,
        dailyCapPercent: null,
        reserveStatus: null,
        hotBalanceUnits: null,
        coldBalanceUnits: null,
        refillDueSince: null,
        sourceStatus: {
          wallet: "healthy",
          payouts: "error",
          reserve: "error",
          refillTimer: "healthy",
        },
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
          key: "payout-monitoring-unavailable",
          severity: "PAGE",
          title: "Payout monitoring is unavailable",
          lines: ["Payout source could not be queried"],
        },
      ],
    });

    const html = renderToStaticMarkup(await AdminStatusHealthPage());

    expect(html).toContain("Payout monitoring is unavailable");
    expect(html).toContain("Payout activity</div><div class=\"mt-3 font-headline text-3xl font-extrabold tracking-tight text-on-surface\">—</div>");
    expect(html).toContain("Daily payout cap</div><div class=\"mt-3 font-headline text-3xl font-extrabold tracking-tight text-on-surface\">—</div>");
    expect(html).toContain("Permanent failures</div><div class=\"mt-3 font-headline text-3xl font-extrabold tracking-tight text-on-surface\">—</div>");
    expect(html).not.toContain("0 payouts");
  });

  it("keeps rail health rendered when the legacy database snapshot fails", async () => {
    mockGetHealthSnapshot.mockRejectedValueOnce(new Error("database unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const html = renderToStaticMarkup(await AdminStatusHealthPage());

    // Independent rail health survives: wallet cards, cap card, and the banner.
    expect(html).toContain("5.0000 USDC");
    expect(html).toContain("6.0000 XLM spendable");
    expect(html).toContain("80% used");
    expect(html).toContain("Daily payout cap is approaching");
    // Legacy database-backed cards report unavailable rather than a false zero.
    expect(html).toContain("Queue and task metrics are unavailable");
    expect(html).toContain("Pending</div><div class=\"mt-3 font-headline text-3xl font-extrabold tracking-tight text-on-surface\">—</div>");
    expect(html).not.toContain("Stuck payout detected");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("database unavailable");
    errors.mockRestore();
  });
});
