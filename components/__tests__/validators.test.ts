import { describe, it } from "node:test";
import assert from "node:assert";
import { validateReason } from "@/lib/validators";

describe("Issue #121 - Text Heuristic Validation Suite", () => {
  it("should allow valid descriptive sentences", () => {
    assert.strictEqual(
      validateReason("What are the strengths of response A?"), 
      true
    );
    assert.strictEqual(
      validateReason("I chose this for its length and clarity."), 
      true
    );
  });

  it("should allow compact but clear 3-word submissions", () => {
    assert.strictEqual(
      validateReason("This is good"), 
      true
    );
  });

  it("should reject raw home-row keyboard mashing", () => {
    assert.strictEqual(
      validateReason("asdfghjklm"), 
      false
    );
    assert.strictEqual(
      validateReason("Wedxtcsfmbxd"), 
      false
    );
  });

  it("should reject high density single character spam", () => {
    assert.strictEqual(
      validateReason("aaaaaaaaaa"), 
      false
    );
  });

  it("should reject entries with insufficient word boundaries", () => {
    assert.strictEqual(
      validateReason("Response good"), 
      false
    );
    assert.strictEqual(
      validateReason("Supercalifragilistic"), 
      false
    );
  });

  it("should reject sentences containing isolated gibberish words", () => {
    assert.strictEqual(
      validateReason("This is asdfghjklm"), 
      false
    );
  });
});