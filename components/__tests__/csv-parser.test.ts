import { describe, it } from "node:test";
import assert from "node:assert";
import { parseCSV } from "@/lib/csv-parser";

const validCSV = `prompt,responseA,responseB,category
What is the capital of France?,Paris,Lyon,general
What is 2+2?,4,5,math
Explain photosynthesis.,Plants making food from sunlight.,Plants convert CO2 and water into glucose and oxygen using light energy.,explanation
`;

const csvWithGoldHeaders = `prompt,responseA,responseB,isGold,goldAnswer
What is the capital of France?,Paris,Lyon,True,A
What is 2+2?,4,5,False,
`;

const csvWithGoldAnswerOnly = `prompt,responseA,responseB,goldAnswer
What is the capital of France?,Paris,Lyon,A
What is 2+2?,4,5,
`;

const csvMissingRequiredColumn = `prompt,responseA,other\nrow1,col2,col3\nrow2,col2,col3`;

describe("parseCSV", () => {
  it("parses a valid CSV into rows", () => {
    const { rows, errors } = parseCSV(validCSV);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(rows.length, 3);

    assert.strictEqual(rows[0].prompt, "What is the capital of France?");
    assert.strictEqual(rows[0].responseA, "Paris");
    assert.strictEqual(rows[0].responseB, "Lyon");
    assert.strictEqual(rows[0].category, "general");

    assert.strictEqual(rows[2].prompt, "Explain photosynthesis.");
    assert.strictEqual(rows[2].responseA, "Plants making food from sunlight.");
  });

  it("rejects CSV containing isGold header", () => {
    const { rows, errors } = parseCSV(csvWithGoldHeaders);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /must not contain isGold/);
  });

  it("rejects CSV containing goldAnswer header", () => {
    const { rows, errors } = parseCSV(csvWithGoldAnswerOnly);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /must not contain isGold/);
  });

  it("returns empty rows for CSV with no data rows", () => {
    const { rows, errors } = parseCSV(`prompt,responseA,responseB`);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(errors.length, 0);
  });

  it("returns error for missing required columns", () => {
    const { rows, errors } = parseCSV(csvMissingRequiredColumn);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /must have prompt, responseA, responseB/);
  });

  it("isGold/goldAnswer check is case-insensitive", () => {
    const csv = `prompt,responseA,responseB,ISGOLD
What is the capital of France?,Paris,Lyon,True
`;
    const { rows, errors } = parseCSV(csv);
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /must not contain isGold/);
  });
});
