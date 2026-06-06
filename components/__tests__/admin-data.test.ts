import { describe, it, expect } from "vitest";
import {
  evaluateBanRule,
  isStuckPending,
  computeCooldownBan,
  isPermanentlyBanned,
  isInCooldown,
  isInRetest,
} from "@/lib/admin-data";

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
    const r = evaluateBanRule({ goldAttempted: 3, goldCorrect: 1 });
    expect(r.shouldBan).toBe(true);
  });
});

describe("computeCooldownBan", () => {
  it("tier 1: 24h cooldown for first-time ban", () => {
    const now = new Date();
    const r = computeCooldownBan(0, null, now);
    expect(r.banCount).toBe(1);
    expect(r.bannedUntil.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(r.reason).toMatch(/24h/);
  });

  it("tier 2: escalates to 72h when last ban was within 30 days", () => {
    const now = new Date();
    const lastBan = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    const r = computeCooldownBan(1, lastBan, now);
    expect(r.banCount).toBe(2);
    expect(r.bannedUntil.getTime() - now.getTime()).toBe(72 * 60 * 60 * 1000);
    expect(r.reason).toMatch(/72h/);
  });

  it("tier 3: permanent ban when banCount already 2 within 30 days", () => {
    const now = new Date();
    const lastBan = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago
    const r = computeCooldownBan(2, lastBan, now);
    expect(r.banCount).toBe(3);
    expect(r.bannedUntil.getTime()).toBe(0); // permanent sentinel
    expect(r.reason).toMatch(/permanent/);
  });

  it("resets to tier 1 when last ban was > 30 days ago", () => {
    const now = new Date();
    const lastBan = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const r = computeCooldownBan(2, lastBan, now);
    expect(r.banCount).toBe(1);
    expect(r.bannedUntil.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("handles null lastBanAt as first ban", () => {
    const now = new Date();
    const r = computeCooldownBan(0, null, now);
    expect(r.banCount).toBe(1);
  });
});

describe("isPermanentlyBanned", () => {
  it("returns true for permanent ban", () => {
    expect(isPermanentlyBanned(true, new Date(0), 3)).toBe(true);
  });

  it("returns false when isBanned is false", () => {
    expect(isPermanentlyBanned(false, new Date(0), 3)).toBe(false);
  });

  it("returns false for cooldown ban", () => {
    const future = new Date(Date.now() + 3600000);
    expect(isPermanentlyBanned(true, future, 1)).toBe(false);
  });

  it("returns false when bannedUntil is null", () => {
    expect(isPermanentlyBanned(true, null, 3)).toBe(false);
  });
});

describe("isInCooldown", () => {
  it("returns true when bannedUntil is in the future", () => {
    const future = new Date(Date.now() + 3600000);
    expect(isInCooldown(true, future)).toBe(true);
  });

  it("returns false when bannedUntil is in the past", () => {
    const past = new Date(Date.now() - 3600000);
    expect(isInCooldown(true, past)).toBe(false);
  });

  it("returns false when isBanned is false", () => {
    expect(isInCooldown(false, new Date(Date.now() + 3600000))).toBe(false);
  });

  it("returns false for permanent ban sentinel", () => {
    expect(isInCooldown(true, new Date(0))).toBe(false);
  });
});

describe("isInRetest", () => {
  it("returns true when cooldown expired and banCount < 3", () => {
    const past = new Date(Date.now() - 3600000);
    expect(isInRetest(true, past, 1)).toBe(true);
  });

  it("returns false when still in cooldown", () => {
    const future = new Date(Date.now() + 3600000);
    expect(isInRetest(true, future, 1)).toBe(false);
  });

  it("returns false for permanent ban", () => {
    expect(isInRetest(true, new Date(0), 3)).toBe(false);
  });

  it("returns false when bannedUntil is null", () => {
    expect(isInRetest(true, null, 1)).toBe(false);
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
