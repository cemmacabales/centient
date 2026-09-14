import { describe, it, expect } from "vitest";
import {
  fixtureTxHash,
  isFixtureTxHash,
  isRealBroadcastHash,
  isResettableHash,
} from "../hash";

// The reset's only safety property lives in these predicates: a row recording a
// payment that actually settled must survive every reset, forever. Everything
// else here is secondary to that one assertion.

const REAL_HASH = "3389e9f0f1a65f19736cacf544c2e825313e8447f8b4dd1a0f7e2f2e2b1cd1a0";

describe("isRealBroadcastHash", () => {
  it("recognises a Horizon hash", () => {
    expect(isRealBroadcastHash(REAL_HASH)).toBe(true);
  });

  it("accepts uppercase hex too", () => {
    // Horizon emits lowercase. Accepting uppercase is deliberate over-inclusion:
    // it can only ever prevent a deletion, never cause one.
    expect(isRealBroadcastHash(REAL_HASH.toUpperCase())).toBe(true);
  });

  it("ignores surrounding whitespace rather than being fooled by it", () => {
    expect(isRealBroadcastHash(`  ${REAL_HASH}  `)).toBe(true);
  });

  it("rejects a hash of the wrong length", () => {
    expect(isRealBroadcastHash(REAL_HASH.slice(0, 63))).toBe(false);
    expect(isRealBroadcastHash(`${REAL_HASH}0`)).toBe(false);
  });

  it("rejects absent hashes", () => {
    expect(isRealBroadcastHash(null)).toBe(false);
    expect(isRealBroadcastHash(undefined)).toBe(false);
    expect(isRealBroadcastHash("")).toBe(false);
  });
});

describe("fixtureTxHash", () => {
  it("mints a hash that can never be mistaken for a Horizon one", () => {
    const hash = fixtureTxHash("m9x1k4", 3);
    expect(hash).toBe("qa-m9x1k4-3");
    expect(isRealBroadcastHash(hash)).toBe(false);
    expect(isFixtureTxHash(hash)).toBe(true);
  });

  it("refuses a run id that would produce an unrecognisable hash", () => {
    // A rejected run id is a loud failure; an accepted one containing an
    // unexpected character would silently mint hashes the reset cannot match,
    // stranding every fixture row it touched.
    expect(() => fixtureTxHash("M9X1K4", 1)).toThrow(/lowercase alphanumeric/);
    expect(() => fixtureTxHash("run-1", 1)).toThrow(/lowercase alphanumeric/);
    expect(() => fixtureTxHash("", 1)).toThrow(/lowercase alphanumeric/);
  });

  it("refuses a non-integer index", () => {
    expect(() => fixtureTxHash("m9x1k4", 1.5)).toThrow(/non-negative integer/);
    expect(() => fixtureTxHash("m9x1k4", -1)).toThrow(/non-negative integer/);
  });

  it("never collides with a Horizon hash across a wide range of run ids", () => {
    for (const runId of ["a", "0", "m9x1k4", "zzzzzzzzzzzz", "1234567890"]) {
      for (const index of [0, 1, 11, 9999]) {
        expect(isRealBroadcastHash(fixtureTxHash(runId, index))).toBe(false);
      }
    }
  });
});

describe("isResettableHash", () => {
  it("a row that never broadcast is removable", () => {
    expect(isResettableHash(null)).toBe(true);
    expect(isResettableHash(undefined)).toBe(true);
    expect(isResettableHash("")).toBe(true);
    expect(isResettableHash("   ")).toBe(true);
  });

  it("REFUSES to remove a row carrying a real broadcast hash", () => {
    // The one assertion this whole module exists to make true.
    expect(isResettableHash(REAL_HASH)).toBe(false);
    expect(isResettableHash(REAL_HASH.toUpperCase())).toBe(false);
    expect(isResettableHash(` ${REAL_HASH} `)).toBe(false);
  });

  it("removes a hash this module minted", () => {
    expect(isResettableHash(fixtureTxHash("m9x1k4", 0))).toBe(true);
  });

  it("preserves an unrecognised hash rather than guessing", () => {
    // Not Horizon-shaped and not ours: something else wrote it. Preserving a row
    // that did not need preserving costs a stale fixture; deleting one that
    // recorded a real payment destroys the evidence it happened.
    expect(isResettableHash("abc")).toBe(false);
    expect(isResettableHash("qa-fixture")).toBe(false);
    expect(isResettableHash("QA-M9X1K4-0")).toBe(false);
    expect(isResettableHash("manually-entered-by-an-operator")).toBe(false);
  });
});
