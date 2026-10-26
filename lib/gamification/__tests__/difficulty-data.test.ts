// #201 — the difficulty map the seed writes onto live tasks. It must match the
// 9 Oct pool pricing exactly: 248 tasks, difficulty 1–9, nothing else.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const map = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../prisma/data/task-difficulty-2026-10-09.json"), "utf8"),
) as Record<string, unknown>;

describe("task-difficulty-2026-10-09.json", () => {
  it("holds a difficulty from 1 to 9 for each of the 248 priced tasks", () => {
    const values = Object.values(map);
    expect(values).toHaveLength(248);
    for (const v of values) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it("matches the pool pricing's spread by difficulty", () => {
    const counts: Record<number, number> = {};
    for (const v of Object.values(map) as number[]) counts[v] = (counts[v] ?? 0) + 1;
    expect(counts).toEqual({ 1: 14, 2: 29, 3: 15, 4: 61, 5: 71, 6: 41, 7: 8, 8: 6, 9: 3 });
  });
});
