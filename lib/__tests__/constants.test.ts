import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMinWithdrawalUnits } from "@/lib/constants";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getMinWithdrawalUnits", () => {
  it("returns the configured MIN_WITHDRAWAL_UNITS as a bigint", () => {
    process.env.MIN_WITHDRAWAL_UNITS = "50000000"; // 5 XLM
    expect(getMinWithdrawalUnits()).toBe(50000000n);
  });

  it("accepts zero (no effective minimum)", () => {
    process.env.MIN_WITHDRAWAL_UNITS = "0";
    expect(getMinWithdrawalUnits()).toBe(0n);
  });

  it("throws when MIN_WITHDRAWAL_UNITS is unset", () => {
    delete process.env.MIN_WITHDRAWAL_UNITS;
    expect(() => getMinWithdrawalUnits()).toThrow("MIN_WITHDRAWAL_UNITS");
  });

  it("throws when MIN_WITHDRAWAL_UNITS is not a non-negative integer string", () => {
    process.env.MIN_WITHDRAWAL_UNITS = "not-a-number";
    expect(() => getMinWithdrawalUnits()).toThrow("MIN_WITHDRAWAL_UNITS");
  });

  it("throws when MIN_WITHDRAWAL_UNITS is negative", () => {
    process.env.MIN_WITHDRAWAL_UNITS = "-1";
    expect(() => getMinWithdrawalUnits()).toThrow("MIN_WITHDRAWAL_UNITS");
  });
});
