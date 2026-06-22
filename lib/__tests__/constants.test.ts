import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMinWithdrawalWei } from "@/lib/constants";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getMinWithdrawalWei", () => {
  it("returns the configured MIN_WITHDRAWAL_WEI as a bigint", () => {
    process.env.MIN_WITHDRAWAL_WEI = "5000000000000000000";
    expect(getMinWithdrawalWei()).toBe(5000000000000000000n);
  });

  it("accepts zero (no effective minimum)", () => {
    process.env.MIN_WITHDRAWAL_WEI = "0";
    expect(getMinWithdrawalWei()).toBe(0n);
  });

  it("throws when MIN_WITHDRAWAL_WEI is unset", () => {
    delete process.env.MIN_WITHDRAWAL_WEI;
    expect(() => getMinWithdrawalWei()).toThrow("MIN_WITHDRAWAL_WEI");
  });

  it("throws when MIN_WITHDRAWAL_WEI is not a non-negative integer string", () => {
    process.env.MIN_WITHDRAWAL_WEI = "not-a-number";
    expect(() => getMinWithdrawalWei()).toThrow("MIN_WITHDRAWAL_WEI");
  });

  it("throws when MIN_WITHDRAWAL_WEI is negative", () => {
    process.env.MIN_WITHDRAWAL_WEI = "-1";
    expect(() => getMinWithdrawalWei()).toThrow("MIN_WITHDRAWAL_WEI");
  });
});
