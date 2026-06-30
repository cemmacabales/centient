import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMinWithdrawalStroops } from "@/lib/constants";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getMinWithdrawalStroops", () => {
  it("returns the configured MIN_WITHDRAWAL_STROOPS as a bigint", () => {
    process.env.MIN_WITHDRAWAL_STROOPS = "50000000"; // 5 XLM
    expect(getMinWithdrawalStroops()).toBe(50000000n);
  });

  it("accepts zero (no effective minimum)", () => {
    process.env.MIN_WITHDRAWAL_STROOPS = "0";
    expect(getMinWithdrawalStroops()).toBe(0n);
  });

  it("throws when MIN_WITHDRAWAL_STROOPS is unset", () => {
    delete process.env.MIN_WITHDRAWAL_STROOPS;
    expect(() => getMinWithdrawalStroops()).toThrow("MIN_WITHDRAWAL_STROOPS");
  });

  it("throws when MIN_WITHDRAWAL_STROOPS is not a non-negative integer string", () => {
    process.env.MIN_WITHDRAWAL_STROOPS = "not-a-number";
    expect(() => getMinWithdrawalStroops()).toThrow("MIN_WITHDRAWAL_STROOPS");
  });

  it("throws when MIN_WITHDRAWAL_STROOPS is negative", () => {
    process.env.MIN_WITHDRAWAL_STROOPS = "-1";
    expect(() => getMinWithdrawalStroops()).toThrow("MIN_WITHDRAWAL_STROOPS");
  });
});
