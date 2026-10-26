// #202 — the optional `difficulty` column in a campaign CSV.
import { describe, it, expect } from "vitest";
import { parseCSV } from "@/lib/csv-parser";

const csv = (header: string, ...rows: string[]) => [header, ...rows].join("\n");

describe("parseCSV - difficulty (#202)", () => {
  it("reads a difficulty from 1 to 9", () => {
    const { rows, errors } = parseCSV(csv("prompt,responseA,responseB,difficulty", "q1,a,b,1", "q2,a,b,9", "q3,a,b, 5 "));
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.difficulty)).toEqual([1, 9, 5]);
  });

  it("leaves it unset when the column is absent", () => {
    const { rows } = parseCSV(csv("prompt,responseA,responseB", "q,a,b"));
    expect(rows[0].difficulty).toBeUndefined();
  });

  it("leaves it unset when the cell is empty: the task is open to every tier", () => {
    const { rows, errors } = parseCSV(csv("prompt,responseA,responseB,difficulty", "q,a,b,"));
    expect(errors).toEqual([]);
    expect(rows[0].difficulty).toBeUndefined();
  });

  it.each(["0", "10", "4.5", "hard", "-3"])("rejects %s with the row and the range", (value) => {
    const { rows, errors } = parseCSV(csv("prompt,responseA,responseB,difficulty", `q,a,b,${value}`, "ok,a,b,3"));
    expect(rows.map((r) => r.prompt)).toEqual(["ok"]);
    expect(errors).toEqual([`Row 2: difficulty must be a whole number from 1 to 9, got "${value}"`]);
  });

  it("matches the header in any case", () => {
    const { rows } = parseCSV(csv("prompt,responseA,responseB,Difficulty", "q,a,b,4"));
    expect(rows[0].difficulty).toBe(4);
  });
});
