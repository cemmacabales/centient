import { describe, it, expect } from "vitest";
import { validateReason } from "@/lib/validators";

describe("Issue #121 - Text Heuristic Validation Suite", () => {
  it("should allow valid descriptive sentences", () => {
    expect(validateReason("What are the strengths of response A?")).toBe(true);
    expect(validateReason("I chose this for its length and clarity.")).toBe(true);
  });

  it("should allow compact but clear 3-word submissions", () => {
    expect(validateReason("This is good")).toBe(true);
  });

  it("should reject raw home-row keyboard mashing", () => {
    expect(validateReason("asdfghjklm")).toBe(false);
    expect(validateReason("Wedxtcsfmbxd")).toBe(false);
  });

  it("should reject high density single character spam", () => {
    expect(validateReason("aaaaaaaaaa")).toBe(false);
  });

  it("should reject entries with insufficient word boundaries", () => {
    expect(validateReason("Response good")).toBe(false);
    expect(validateReason("Supercalifragilistic")).toBe(false);
  });

  it("should reject sentences containing isolated gibberish words", () => {
    expect(validateReason("This is asdfghjklm")).toBe(false);
  });
});