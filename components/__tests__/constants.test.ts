import { describe, it } from "node:test";
import assert from "node:assert";
import { parseGoldRatio } from "@/lib/constants";

describe("parseGoldRatio", () => {
  it("returns default 0.1 when raw is undefined", () => {
    assert.strictEqual(parseGoldRatio(undefined), 0.1);
  });

  it("returns 0.1 for explicit default string", () => {
    assert.strictEqual(parseGoldRatio("0.1"), 0.1);
  });

  it("parses valid ratio strings", () => {
    assert.strictEqual(parseGoldRatio("0"), 0);
    assert.strictEqual(parseGoldRatio("0.5"), 0.5);
    assert.strictEqual(parseGoldRatio("1"), 1);
  });

  it("throws for negative values", () => {
    assert.throws(() => parseGoldRatio("-0.1"), /GOLD_TASK_RATIO must be between 0 and 1/);
  });

  it("throws for values above 1", () => {
    assert.throws(() => parseGoldRatio("1.5"), /GOLD_TASK_RATIO must be between 0 and 1/);
  });

  it("throws for non-numeric strings", () => {
    assert.throws(() => parseGoldRatio("abc"), /GOLD_TASK_RATIO must be between 0 and 1/);
  });
});
