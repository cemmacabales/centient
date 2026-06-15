import { describe, it, expect } from "vitest";
import { parseGoldRatio } from "@/lib/constants";

describe("parseGoldRatio", () => {
  it("returns default 0.1 when raw is undefined", () => {
    expect(parseGoldRatio(undefined)).toBe(0.1);
  });

  it("returns 0.1 for explicit default string", () => {
    expect(parseGoldRatio("0.1")).toBe(0.1);
  });

  it("parses valid ratio strings", () => {
    expect(parseGoldRatio("0")).toBe(0);
    expect(parseGoldRatio("0.5")).toBe(0.5);
    expect(parseGoldRatio("1")).toBe(1);
  });

  it("throws for negative values", () => {
    expect(() => parseGoldRatio("-0.1")).toThrow(/GOLD_TASK_RATIO must be between 0 and 1/);
  });

  it("throws for values above 1", () => {
    expect(() => parseGoldRatio("1.5")).toThrow(/GOLD_TASK_RATIO must be between 0 and 1/);
  });

  it("returns default 0.1 for empty string", () => {
    expect(parseGoldRatio("")).toBe(0.1);
  });

  it("throws for non-numeric strings", () => {
    expect(() => parseGoldRatio("abc")).toThrow(/GOLD_TASK_RATIO must be between 0 and 1/);
  });
});
