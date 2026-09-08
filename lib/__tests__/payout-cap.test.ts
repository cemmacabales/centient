import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockPayoutJobAggregate, mockSendAlert } = vi.hoisted(() => ({
  mockPayoutJobAggregate: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock("../prisma", () => ({
  __esModule: true,
  default: {
    payoutJob: {
      aggregate: mockPayoutJobAggregate,
    },
  },
}));

vi.mock("../redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("../health-alert", () => ({
  sendDedupedDiscordAlert: mockSendAlert,
}));

import {
  getDailyPayoutCapUnits,
  getPayoutActivitySince,
  getRolling24hPayoutSum,
  checkPayoutCap,
  maybeSendCapAlert,
  buildPayoutCapAlert,
} from "../payout-cap";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.DAILY_PAYOUT_CAP_UNITS;
});

describe("getDailyPayoutCapUnits", () => {
  it("returns default when env var is not set", () => {
    expect(getDailyPayoutCapUnits()).toBe(2_000_000_000n); // 200 XLM
  });

  it("parses custom env var", () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "100000000000000000000";
    expect(getDailyPayoutCapUnits()).toBe(100_000000000000000000n);
  });

  it("falls back to default for negative values", () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "-1";
    expect(getDailyPayoutCapUnits()).toBe(2_000_000_000n); // 200 XLM
  });

  it("returns 0n when explicitly set to 0", () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "0";
    expect(getDailyPayoutCapUnits()).toBe(0n);
  });
});

describe("getPayoutActivitySince", () => {
  it("derives broadcast payout activity from eligible payout jobs", async () => {
    const since = new Date("2026-09-07T12:00:00.000Z");
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _count: { _all: 2 },
      _sum: { amountUnits: 750_000_000n },
      _avg: null,
      _min: null,
      _max: null,
    });

    const result = await getPayoutActivitySince(since);

    expect(mockPayoutJobAggregate).toHaveBeenCalledWith({
      _count: { _all: true },
      _sum: { amountUnits: true },
      where: {
        broadcastAt: { gte: since },
        txHash: { not: null },
        amountUnits: { not: null },
      },
    });
    expect(result).toEqual({ count: 2, volumeUnits: 750_000_000n });
  });

  it("returns a zero volume when eligible jobs have no aggregate sum", async () => {
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _count: { _all: 0 },
      _sum: { amountUnits: null },
      _avg: null,
      _min: null,
      _max: null,
    });

    await expect(getPayoutActivitySince(new Date("2026-09-07T12:00:00.000Z"))).resolves.toEqual({
      count: 0,
      volumeUnits: 0n,
    });
  });
});

describe("getRolling24hPayoutSum", () => {
  it("returns the volume from broadcast payout activity", async () => {
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _count: { _all: 1 },
      _sum: { amountUnits: 50_000_000_000_000_000n },
      _avg: null,
      _min: null,
      _max: null,
    });

    await expect(getRolling24hPayoutSum()).resolves.toBe(50_000_000_000_000_000n);
  });
});

describe("checkPayoutCap", () => {
  it("allows payout when under cap", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "500000000000000000000";
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _sum: { amountUnits: 100000000000000000000n },
      _count: { _all: 1 },
      _avg: null,
      _min: null,
      _max: null,
    });

    const result = await checkPayoutCap(50000000000000000n);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(100000000000000000000n);
    expect(result.cap).toBe(500000000000000000000n);
  });

  it("throws PayoutCapError when cap would be exceeded", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "200000000000000000000";
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _sum: { amountUnits: 190000000000000000000n },
      _count: { _all: 1 },
      _avg: null,
      _min: null,
      _max: null,
    });

    await expect(
      checkPayoutCap(20000000000000000000n),
    ).rejects.toMatchObject({
      code: "daily_cap_reached",
      currentUnits: 190000000000000000000n,
      capUnits: 200000000000000000000n,
    });
  });

  it("allows payout exactly at cap", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "200000000000000000000";
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _sum: { amountUnits: 150000000000000000000n },
      _count: { _all: 1 },
      _avg: null,
      _min: null,
      _max: null,
    });

    const result = await checkPayoutCap(50000000000000000000n);
    expect(result.allowed).toBe(true);
  });

  it("allows all payouts when cap is 0 (disabled)", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "0";

    const result = await checkPayoutCap(100000000000000000000n);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(0n);
    expect(result.cap).toBe(0n);
    expect(result.remaining).toBe(0n);
  });
});

describe("buildPayoutCapAlert", () => {
  it("pages with an exhausted title once the cap is fully consumed", () => {
    const alert = buildPayoutCapAlert(1000n, 1000n, 80);

    expect(alert).toMatchObject({
      key: "payout-cap",
      severity: "PAGE",
      title: "Daily payout cap is exhausted",
    });
    expect(alert!.lines).toEqual(["100% consumed", "1000 of 1000 units spent", "0 units remain"]);
  });

  it("warns that the cap is approaching below 100 percent", () => {
    expect(buildPayoutCapAlert(800n, 1000n, 80)).toMatchObject({
      severity: "WARN",
      title: "Daily payout cap is approaching",
    });
  });

  it("returns nothing below the threshold or without a cap", () => {
    expect(buildPayoutCapAlert(799n, 1000n, 80)).toBeNull();
    expect(buildPayoutCapAlert(800n, 0n, 80)).toBeNull();
  });
});

describe("maybeSendCapAlert", () => {
  it("uses the shared payout-cap alert identity at 80 percent", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "1000";
    mockPayoutJobAggregate.mockResolvedValueOnce({
      _count: { _all: 1 },
      _sum: { amountUnits: 800n },
    });
    mockSendAlert.mockResolvedValueOnce("sent");

    const result = await maybeSendCapAlert();

    expect(result).toBe("sent");
    expect(mockSendAlert).toHaveBeenCalledWith({
      key: "payout-cap",
      severity: "WARN",
      title: "Daily payout cap is approaching",
      lines: ["80% consumed", "800 of 1000 units spent", "200 units remain"],
    });
  });
});
