import assert from "assert";
import { validateReason } from "./TaskCard";

console.log("⏳ Running updated Issue #121 regression test suite...");

try {
  // --- 1. SHOULD PASS CASES (Valid Inputs & Supervisor edge-cases) ---
  
  // A sentence with strengths or lengths
  assert.strictEqual(
    validateReason("What are the strengths of response A?"), 
    true, 
    "❌ Failed: Valid sentences containing 'strengths' must be allowed."
  );
  assert.strictEqual(
    validateReason("I chose this for its length and clarity."), 
    true, 
    "❌ Failed: Valid sentences containing 'length' must be allowed."
  );

  // Exactly 3 words (Should PASS)
  assert.strictEqual(
    validateReason("This is good"), 
    true, 
    "❌ Failed: Exactly 3 words over 10 chars should pass."
  );

  // Valid short explanation (Should PASS)
  assert.strictEqual(
    validateReason("Response B provides much better code context."), 
    true, 
    "❌ Failed: Standard descriptive input should pass."
  );


  // --- 2. SHOULD FAIL CASES (Spam & Gibberish) ---

  // Keyboard mash like asdfghjkl (Should FAIL)
  assert.strictEqual(
    validateReason("asdfghjklm"), 
    false, 
    "❌ Failed: Should reject standard home-row keyboard mashing."
  );
  assert.strictEqual(
    validateReason("Wedxtcsfmbxd"), 
    false, 
    "❌ Failed: Should reject vowel-less random string."
  );

  // Repeated character spam like aaaaaaaaaa (Should FAIL)
  assert.strictEqual(
    validateReason("aaaaaaaaaa"), 
    false, 
    "❌ Failed: Should reject letter repetition spam."
  );

  // Less than 3 words (Should FAIL)
  assert.strictEqual(
    validateReason("Response good"), 
    false, 
    "❌ Failed: Should reject 2-word inputs even if length requirement is met."
  );
  assert.strictEqual(
    validateReason("Supercalifragilistic"), 
    false, 
    "❌ Failed: Should reject a single long word."
  );

  // Word count is 3, but contains an isolated keyboard mash (Should fail)
  assert.strictEqual(
    validateReason("This is asdfghjkl"),
    false,
    "❌ Failed: Should reject sentences containing isolated gibberish words."
  )

  console.log("\n████████████████████████████████████████████████████████");
  console.log("✅ SUCCESS: All regression test criteria satisfied!");
  console.log("████████████████████████████████████████████████████████");

} catch (error: any) {
  console.error("\n❌ TEST SUITE FAILURE:");
  console.error(error.message);
  process.exit(1);
}