import { describe, it, expect } from "vitest";
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
    expect(errors.length).toBe(0);
    expect(rows.length).toBe(3);

    expect(rows[0].prompt).toBe("What is the capital of France?");
    expect(rows[0].responseA).toBe("Paris");
    expect(rows[0].responseB).toBe("Lyon");
    expect(rows[0].category).toBe("general");

    expect(rows[2].prompt).toBe("Explain photosynthesis.");
    expect(rows[2].responseA).toBe("Plants making food from sunlight.");
  });

  it("parses isGold and goldAnswer from CSV headers", () => {
    const { rows, errors } = parseCSV(csvWithGoldHeaders);
    expect(errors.length).toBe(0);
    expect(rows.length).toBe(2);

    expect(rows[0].isGold).toBe(true);
    expect(rows[0].goldAnswer).toBe("A");
    expect(rows[1].isGold).toBe(false);
    expect(rows[1].goldAnswer).toBeUndefined();
  });

  it("parses goldAnswer-only CSV without error", () => {
    const { rows, errors } = parseCSV(csvWithGoldAnswerOnly);
    expect(errors.length).toBe(0);
    expect(rows.length).toBe(2);

    expect(rows[0].isGold).toBe(false);
    expect(rows[0].goldAnswer).toBeUndefined();
    expect(rows[1].isGold).toBe(false);
    expect(rows[1].goldAnswer).toBeUndefined();
  });

  it("returns empty rows for CSV with no data rows", () => {
    const { rows, errors } = parseCSV(`prompt,responseA,responseB`);
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(0);
  });

  it("returns error for missing required columns", () => {
    const { rows, errors } = parseCSV(csvMissingRequiredColumn);
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/must have prompt, responseA, responseB/);
  });

  it("isGold/goldAnswer headers are case-insensitive", () => {
    const csv = `prompt,responseA,responseB,ISGOLD,GOLDANSWER
What is the capital of France?,Paris,Lyon,True,A
`;
    const { rows, errors } = parseCSV(csv);
    expect(errors.length).toBe(0);
    expect(rows.length).toBe(1);
    expect(rows[0].isGold).toBe(true);
    expect(rows[0].goldAnswer).toBe("A");
  });

  it("rejects rows with isGold=true but invalid goldAnswer", () => {
    const csv = `prompt,responseA,responseB,isGold,goldAnswer
What is the capital of France?,Paris,Lyon,True,C
`;
    const { rows, errors } = parseCSV(csv);
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/isGold is true but goldAnswer is missing or invalid/);
  });

  it("rejects rows with isGold=true but missing goldAnswer", () => {
    const csv = `prompt,responseA,responseB,isGold,goldAnswer
What is the capital of France?,Paris,Lyon,True,
`;
    const { rows, errors } = parseCSV(csv);
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/isGold is true but goldAnswer is missing or invalid/);
  });

  it("accepts isGold=1 and isGold=yes as true", () => {
    const csv = `prompt,responseA,responseB,isGold,goldAnswer
Which is bigger?,Sun,Moon,1,A
What color is the sky?,Blue,Red,yes,B
`;
    const { rows, errors } = parseCSV(csv);
    expect(errors.length).toBe(0);
    expect(rows.length).toBe(2);
    expect(rows[0].isGold).toBe(true);
    expect(rows[1].isGold).toBe(true);
  });
});
