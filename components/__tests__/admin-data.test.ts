import { describe, it, expect } from "vitest";
import { evaluateBanRule, isStuckPending } from "@/lib/admin-data";

describe("evaluateBanRule", () => {
  it("does not ban below the 3-attempt threshold", () => {
    expect(evaluateBanRule({ goldAttempted: 0, goldCorrect: 0 })).toEqual({ shouldBan: false, reason: null });
    expect(evaluateBanRule({ goldAttempted: 1, goldCorrect: 0 })).toEqual({ shouldBan: false, reason: null });
    expect(evaluateBanRule({ goldAttempted: 2, goldCorrect: 0 })).toEqual({ shouldBan: false, reason: null });
  });

  it("bans at >= 3 attempts and < 50% accuracy", () => {
    const r = evaluateBanRule({ goldAttempted: 3, goldCorrect: 1 });
    expect(r.shouldBan).toBe(true);
    expect(r.reason ?? "").toMatch(/auto: gold accuracy 1\/3 < 50%/);
  });

  it("does not ban at exactly 50% accuracy with 3+ attempts", () => {
    expect(evaluateBanRule({ goldAttempted: 3, goldCorrect: 2 })).toEqual({ shouldBan: false, reason: null });
    expect(evaluateBanRule({ goldAttempted: 4, goldCorrect: 2 })).toEqual({ shouldBan: false, reason: null });
  });

  it("does not ban a high-accuracy user at high attempt counts", () => {
    expect(evaluateBanRule({ goldAttempted: 50, goldCorrect: 50 })).toEqual({ shouldBan: false, reason: null });
    expect(evaluateBanRule({ goldAttempted: 50, goldCorrect: 25 })).toEqual({ shouldBan: false, reason: null });
  });

  it("mirrors the production threshold for the canonical 1/3 case", () => {
    // 1 correct out of 3 → 33.3% < 50% → ban
    const r = evaluateBanRule({ goldAttempted: 3, goldCorrect: 1 });
    expect(r.shouldBan).toBe(true);
  });
});

describe("isStuckPending", () => {
  it("flags a submission older than the 5-minute threshold", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    expect(isStuckPending(tenMinAgo)).toBe(true);
  });

  it("does not flag a fresh submission", () => {
    const justNow = new Date(Date.now() - 1000);
    expect(isStuckPending(justNow)).toBe(false);
  });

  it("respects the threshold boundary", () => {
    const justOver = new Date(Date.now() - (5 * 60 * 1000 + 100));
    expect(isStuckPending(justOver)).toBe(true);
    const justUnder = new Date(Date.now() - (5 * 60 * 1000 - 100));
    expect(isStuckPending(justUnder)).toBe(false);
  });
});
