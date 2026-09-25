import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { paymentsLaneSourceFiles } from "@/tests/payments-lane";

// #39 — accumulate-then-withdraw is retired: nothing credits a contributor's
// off-chain balance any more. An accepted answer is paid on-chain (#37), and the
// only balance that remains is a legacy one being withdrawn down to zero
// (ADR-0007). The one write that may still raise `pendingBalanceUnits` is
// `refundReversal`, which returns a failed legacy withdrawal to the balance it
// was taken from; it creates no new value.

const ROOT = path.resolve(__dirname, "../..");

/** Every place a balance increase could be written, as [file, match] pairs. */
function balanceCredits(): Array<[string, string]> {
  const hits: Array<[string, string]> = [];
  const patterns = [
    /type:\s*"CREDIT_REWARD"/g,
    /pendingBalanceUnits:\s*\{\s*increment/g,
    /"pendingBalanceUnits"\s*=\s*"pendingBalanceUnits"\s*\+/g,
  ];
  for (const file of paymentsLaneSourceFiles(ROOT)) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) hits.push([file, match[0]]);
    }
  }
  return hits;
}

describe("no contributor balance accrual path (#39)", () => {
  it("writes no CREDIT_REWARD ledger row anywhere in shipped code", () => {
    expect(balanceCredits().filter(([, m]) => m.includes("CREDIT_REWARD"))).toEqual([]);
  });

  it("raises pendingBalanceUnits only in refundReversal", () => {
    expect(balanceCredits()).toEqual([["lib/user-balance.ts", "pendingBalanceUnits: { increment"]]);
    const userBalance = readFileSync(path.join(ROOT, "lib/user-balance.ts"), "utf8");
    const increment = userBalance.indexOf("pendingBalanceUnits: { increment");
    const owner = userBalance.lastIndexOf("export async function", increment);
    expect(userBalance.slice(owner, increment)).toMatch(/^export async function refundReversal\(/);
  });
});
