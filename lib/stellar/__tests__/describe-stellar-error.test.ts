import { describe, expect, it } from "vitest";
import { describeStellarError } from "../client";

/**
 * F-04b. The reported symptom: a fee-starved payout surfaced only
 * `Request failed with status code 400`, `payoutError` was left NULL, and
 * Horizon's `extras` logged as `[Object]` — so `tx_insufficient_balance` never
 * reached an operator and a correctly-failing payout looked identical to an
 * unexplained one.
 */
function horizonError(message: string, result_codes: unknown): Error {
  const err = new Error(message) as Error & { response?: unknown };
  err.response = { data: { extras: { result_codes } } };
  return err;
}

describe("describeStellarError", () => {
  it("surfaces the transaction result code the operator actually needs", () => {
    const err = horizonError("Request failed with status code 400", {
      transaction: "tx_insufficient_balance",
    });
    expect(describeStellarError(err)).toBe(
      "Request failed with status code 400 (tx_insufficient_balance)",
    );
  });

  it("surfaces operation codes alongside the transaction code", () => {
    const err = horizonError("Request failed with status code 400", {
      transaction: "tx_failed",
      operations: ["op_underfunded"],
    });
    expect(describeStellarError(err)).toBe(
      "Request failed with status code 400 (tx_failed, op_underfunded)",
    );
  });

  it("drops op_success padding so the real code is not buried", () => {
    const err = horizonError("Request failed with status code 400", {
      transaction: "tx_failed",
      operations: ["op_success", "op_no_trust", "op_success"],
    });
    expect(describeStellarError(err)).toBe(
      "Request failed with status code 400 (tx_failed, op_no_trust)",
    );
  });

  it("falls back to the bare message when Horizon gave no codes", () => {
    expect(describeStellarError(new Error("socket hang up"))).toBe("socket hang up");
  });

  it("handles a non-Error rejection without throwing", () => {
    expect(describeStellarError("boom")).toBe("boom");
  });

  it("does not invent a parenthetical when result_codes is empty", () => {
    const err = horizonError("Request failed with status code 400", {});
    expect(describeStellarError(err)).toBe("Request failed with status code 400");
  });
});
