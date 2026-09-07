import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDailyPayoutCapUnits,
  mockGetRolling24hPayoutSum,
  mockGetWalletHealth,
  mockLoadReserveRefillStatus,
  mockPayoutJobCount,
  mockRedisDel,
  mockRedisGet,
  mockRedisSet,
  mockSendAlert,
  mockSubmissionAggregate,
  mockSubmissionCount,
} = vi.hoisted(() => ({
  mockGetDailyPayoutCapUnits: vi.fn(),
  mockGetRolling24hPayoutSum: vi.fn(),
  mockGetWalletHealth: vi.fn(),
  mockLoadReserveRefillStatus: vi.fn(),
  mockPayoutJobCount: vi.fn(),
  mockRedisDel: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockSendAlert: vi.fn(),
  mockSubmissionAggregate: vi.fn(),
  mockSubmissionCount: vi.fn(),
}));

vi.mock("../prisma", () => ({
  default: {
    payoutJob: { count: mockPayoutJobCount },
    submission: {
      aggregate: mockSubmissionAggregate,
      count: mockSubmissionCount,
    },
  },
}));

vi.mock("../payout-cap", () => ({
  getDailyPayoutCapUnits: mockGetDailyPayoutCapUnits,
  getRolling24hPayoutSum: mockGetRolling24hPayoutSum,
}));

vi.mock("../stellar/balance", () => ({
  getWalletHealth: mockGetWalletHealth,
}));

vi.mock("../stellar/reserve-refill", () => ({
  loadReserveRefillStatus: mockLoadReserveRefillStatus,
}));

vi.mock("../redis", () => ({
  redis: {
    del: mockRedisDel,
    get: mockRedisGet,
    set: mockRedisSet,
  },
}));

vi.mock("../health-alert", () => ({
  sendDedupedDiscordAlert: mockSendAlert,
}));

import {
  evaluateHealthAlerts,
  getHealthMonitorSnapshot,
  parseHealthMonitorThresholds,
  runHealthMonitor,
  type HealthMonitorInput,
  type HealthMonitorThresholds,
} from "../health-monitor";

beforeEach(() => {
  vi.clearAllMocks();
});

const THRESHOLDS: HealthMonitorThresholds = {
  payoutWindowMinutes: 60,
  payoutCountThreshold: 100,
  payoutVolumeUnitsThreshold: 1_000_000_000n,
  failureWindowMinutes: 15,
  failureCountThreshold: 3,
  capPercentThreshold: 80,
  refillOverdueMinutes: 30,
};

function healthyInput(overrides: Partial<HealthMonitorInput> = {}): HealthMonitorInput {
  return {
    wallet: {
      address: "GPLATFORM",
      usdcBalance: "500.0000",
      availableXlmBalance: "20.0000",
      sponsoredReserveXlm: "5.0000",
      assetStatus: { usdc: "healthy", xlm: "healthy" },
    },
    payoutCount: 10,
    payoutVolumeUnits: 100_000_000n,
    failedPayoutCount: 0,
    dailyCapUnits: 2_000_000_000n,
    dailySpentUnits: 200_000_000n,
    reserveStatus: "healthy",
    refillDueSinceMs: null,
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("parseHealthMonitorThresholds", () => {
  it("reads every anomaly threshold from environment input", () => {
    expect(
      parseHealthMonitorThresholds({
        HEALTH_PAYOUT_WINDOW_MINUTES: "30",
        HEALTH_PAYOUT_COUNT_THRESHOLD: "40",
        HEALTH_PAYOUT_VOLUME_UNITS_THRESHOLD: "500000000",
        HEALTH_FAILURE_WINDOW_MINUTES: "10",
        HEALTH_FAILURE_COUNT_THRESHOLD: "4",
        HEALTH_CAP_PERCENT_THRESHOLD: "85",
        HEALTH_REFILL_OVERDUE_MINUTES: "45",
      }),
    ).toEqual({
      payoutWindowMinutes: 30,
      payoutCountThreshold: 40,
      payoutVolumeUnitsThreshold: 500_000_000n,
      failureWindowMinutes: 10,
      failureCountThreshold: 4,
      capPercentThreshold: 85,
      refillOverdueMinutes: 45,
    });
  });
});

describe("evaluateHealthAlerts", () => {
  it("reports payout-rate and payout-volume spikes independently", () => {
    const alerts = evaluateHealthAlerts(
      healthyInput({ payoutCount: 100, payoutVolumeUnits: 1_000_000_000n }),
      THRESHOLDS,
    );

    expect(alerts.map((alert) => alert.key)).toEqual([
      "payout-rate-spike",
      "payout-volume-spike",
    ]);
  });

  it("reports the daily cap exactly at the configured percentage", () => {
    const alerts = evaluateHealthAlerts(
      healthyInput({ dailySpentUnits: 1_600_000_000n }),
      THRESHOLDS,
    );

    expect(alerts.map((alert) => alert.key)).toContain("payout-cap");
  });

  it("reports repeated permanent payout failures", () => {
    const alerts = evaluateHealthAlerts(
      healthyInput({ failedPayoutCount: 3 }),
      THRESHOLDS,
    );

    expect(alerts.map((alert) => alert.key)).toContain("repeated-payout-failures");
  });

  it("reports a refill that remains required beyond the overdue window", () => {
    const nowMs = 1_700_000_000_000;
    const alerts = evaluateHealthAlerts(
      healthyInput({
        reserveStatus: "refill_required",
        refillDueSinceMs: nowMs - 30 * 60 * 1000,
        nowMs,
      }),
      THRESHOLDS,
    );

    expect(alerts.map((alert) => alert.key)).toContain("reserve-refill-overdue");
  });

  it("returns no alerts when every metric is below threshold", () => {
    expect(evaluateHealthAlerts(healthyInput(), THRESHOLDS)).toEqual([]);
  });
});

describe("getHealthMonitorSnapshot", () => {
  it("combines live rail metrics and preserves the first time a refill became due", async () => {
    const nowMs = 1_700_000_000_000;
    const dueSinceMs = nowMs - 31 * 60 * 1000;
    mockGetWalletHealth.mockResolvedValue({
      address: "GPLATFORM",
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
    });
    mockSubmissionCount.mockResolvedValue(100);
    mockSubmissionAggregate.mockResolvedValue({ _sum: { payoutAmountUnits: 1_000_000_000n } });
    mockPayoutJobCount.mockResolvedValue(3);
    mockGetDailyPayoutCapUnits.mockReturnValue(2_000_000_000n);
    mockGetRolling24hPayoutSum.mockResolvedValue(1_600_000_000n);
    mockLoadReserveRefillStatus.mockResolvedValue({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 2_000_000_000n,
      coldAfterUnits: 1_250_000_000n,
    });
    mockRedisSet.mockResolvedValue(null);
    mockRedisGet.mockResolvedValue(String(dueSinceMs));

    const snapshot = await getHealthMonitorSnapshot({ nowMs, thresholds: THRESHOLDS });

    expect(snapshot.metrics).toMatchObject({
      payoutCount: 100,
      payoutVolumeUnits: "1000000000",
      failedPayoutCount: 3,
      dailyCapUnits: "2000000000",
      dailySpentUnits: "1600000000",
      dailyCapPercent: 80,
      reserveStatus: "refill_required",
      hotBalanceUnits: "250000000",
      coldBalanceUnits: "2000000000",
      refillDueSince: new Date(dueSinceMs).toISOString(),
    });
    expect(snapshot.alerts.map((alert) => alert.key)).toEqual([
      "wallet-usdc-page",
      "wallet-xlm-page",
      "payout-rate-spike",
      "payout-volume-spike",
      "payout-cap",
      "repeated-payout-failures",
      "reserve-refill-overdue",
    ]);
    expect(mockRedisSet).toHaveBeenCalledWith(
      "t2p:reserve-refill:due-since",
      String(nowMs),
      "NX",
    );
  });

  it("clears the refill-due marker after the reserve becomes healthy", async () => {
    mockGetWalletHealth.mockResolvedValue({
      address: "GPLATFORM",
      usdcBalance: "500.0000",
      xlmBalance: "20.0000",
      availableXlmBalance: "20.0000",
      numSponsoring: 0,
      sponsoredReserveXlm: "0.0000",
      rewardTokenSymbol: "USDC",
      healthy: true,
      warnings: [],
      pages: [],
      assetStatus: { usdc: "healthy", xlm: "healthy" },
      thresholds: { warnUsdc: 50, pageUsdc: 10, warnXlm: 5, pageXlm: 2 },
    });
    mockSubmissionCount.mockResolvedValue(0);
    mockSubmissionAggregate.mockResolvedValue({ _sum: { payoutAmountUnits: null } });
    mockPayoutJobCount.mockResolvedValue(0);
    mockGetDailyPayoutCapUnits.mockReturnValue(2_000_000_000n);
    mockGetRolling24hPayoutSum.mockResolvedValue(0n);
    mockLoadReserveRefillStatus.mockResolvedValue({
      status: "healthy",
      hotBalanceUnits: 1_000_000_000n,
      coldBalanceUnits: 2_000_000_000n,
    });
    mockRedisDel.mockResolvedValue(1);

    const snapshot = await getHealthMonitorSnapshot({
      nowMs: 1_700_000_000_000,
      thresholds: THRESHOLDS,
    });

    expect(snapshot.metrics.refillDueSince).toBeNull();
    expect(snapshot.alerts).toEqual([]);
    expect(mockRedisDel).toHaveBeenCalledWith("t2p:reserve-refill:due-since");
  });
});

describe("runHealthMonitor", () => {
  it("delivers every active alert through the shared dedupe boundary", async () => {
    mockGetWalletHealth.mockResolvedValue({
      address: "GPLATFORM",
      usdcBalance: "5.0000",
      xlmBalance: "20.0000",
      availableXlmBalance: "20.0000",
      numSponsoring: 0,
      sponsoredReserveXlm: "0.0000",
      rewardTokenSymbol: "USDC",
      healthy: false,
      warnings: [],
      pages: ["USDC low"],
      assetStatus: { usdc: "page", xlm: "healthy" },
      thresholds: { warnUsdc: 50, pageUsdc: 10, warnXlm: 5, pageXlm: 2 },
    });
    mockSubmissionCount.mockResolvedValue(0);
    mockSubmissionAggregate.mockResolvedValue({ _sum: { payoutAmountUnits: null } });
    mockPayoutJobCount.mockResolvedValue(0);
    mockGetDailyPayoutCapUnits.mockReturnValue(2_000_000_000n);
    mockGetRolling24hPayoutSum.mockResolvedValue(0n);
    mockLoadReserveRefillStatus.mockResolvedValue({
      status: "healthy",
      hotBalanceUnits: 1_000_000_000n,
      coldBalanceUnits: 2_000_000_000n,
    });
    mockRedisDel.mockResolvedValue(0);
    mockSendAlert.mockResolvedValue("sent");

    const result = await runHealthMonitor({
      nowMs: 1_700_000_000_000,
      thresholds: THRESHOLDS,
    });

    expect(result.deliveries).toEqual([{ key: "wallet-usdc-page", status: "sent" }]);
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "wallet-usdc-page" }),
    );
  });
});
