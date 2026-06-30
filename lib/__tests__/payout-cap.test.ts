import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockAggregate } = vi.hoisted(() => ({
  mockAggregate: vi.fn(),
}));

vi.mock("../prisma", () => ({
  __esModule: true,
  default: {
    submission: {
      aggregate: mockAggregate,
    },
  },
}));

vi.mock("../redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import {
  getDailyPayoutCapUnits,
  getRolling24hPayoutSum,
  checkPayoutCap,
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

describe("getRolling24hPayoutSum", () => {
  it("queries DB and returns sum", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: { payoutAmountUnits: 50000000000000000n },
      _count: null,
      _avg: null,
      _min: null,
      _max: null,
    });

    const sum = await getRolling24hPayoutSum();
    expect(sum).toBe(50000000000000000n);

    const callArgs = mockAggregate.mock.calls[0][0];
    expect(callArgs.where.payoutStatus).toEqual({ in: ["sent", "confirmed"] });
    expect(callArgs.where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("returns 0n when DB sum is null", async () => {
    mockAggregate.mockResolvedValueOnce({
      _sum: { payoutAmountUnits: null },
      _count: null,
      _avg: null,
      _min: null,
      _max: null,
    });

    const sum = await getRolling24hPayoutSum();
    expect(sum).toBe(0n);
  });
});

describe("checkPayoutCap", () => {
  it("allows payout when under cap", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "500000000000000000000";
    mockAggregate.mockResolvedValueOnce({
      _sum: { payoutAmountUnits: 100000000000000000000n },
      _count: null,
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
    mockAggregate.mockResolvedValueOnce({
      _sum: { payoutAmountUnits: 190000000000000000000n },
      _count: null,
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
    mockAggregate.mockResolvedValueOnce({
      _sum: { payoutAmountUnits: 150000000000000000000n },
      _count: null,
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
