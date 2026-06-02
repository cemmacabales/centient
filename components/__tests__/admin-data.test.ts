import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluateBanRule, isStuckPending } from "@/lib/admin-data";

describe("evaluateBanRule", () => {
  it("does not ban below the 3-attempt threshold", () => {
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 0, goldCorrect: 0 }), { shouldBan: false, reason: null });
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 1, goldCorrect: 0 }), { shouldBan: false, reason: null });
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 2, goldCorrect: 0 }), { shouldBan: false, reason: null });
  });

  it("bans at >= 3 attempts and < 50% accuracy", () => {
    const r = evaluateBanRule({ goldAttempted: 3, goldCorrect: 1 });
    assert.strictEqual(r.shouldBan, true);
    assert.match(r.reason ?? "", /auto: gold accuracy 1\/3 < 50%/);
  });

  it("does not ban at exactly 50% accuracy with 3+ attempts", () => {
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 3, goldCorrect: 2 }), { shouldBan: false, reason: null });
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 4, goldCorrect: 2 }), { shouldBan: false, reason: null });
  });

  it("does not ban a high-accuracy user at high attempt counts", () => {
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 50, goldCorrect: 50 }), { shouldBan: false, reason: null });
    assert.deepStrictEqual(evaluateBanRule({ goldAttempted: 50, goldCorrect: 25 }), { shouldBan: false, reason: null });
  });

  it("mirrors the production threshold for the canonical 1/3 case", () => {
    // 1 correct out of 3 → 33.3% < 50% → ban
    const r = evaluateBanRule({ goldAttempted: 3, goldCorrect: 1 });
    assert.strictEqual(r.shouldBan, true);
  });
});

describe("isStuckPending", () => {
  it("flags a submission older than the 5-minute threshold", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    assert.strictEqual(isStuckPending(tenMinAgo), true);
  });

  it("does not flag a fresh submission", () => {
    const justNow = new Date(Date.now() - 1000);
    assert.strictEqual(isStuckPending(justNow), false);
  });

  it("respects the threshold boundary", () => {
    const justOver = new Date(Date.now() - (5 * 60 * 1000 + 100));
    assert.strictEqual(isStuckPending(justOver), true);
    const justUnder = new Date(Date.now() - (5 * 60 * 1000 - 100));
    assert.strictEqual(isStuckPending(justUnder), false);
  });
});
