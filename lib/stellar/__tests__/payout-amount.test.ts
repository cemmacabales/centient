import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { usdcToUnits } from "../config";
import {
  MAX_STELLAR_STROOPS,
  assertPayoutAmountUnits,
  assertPayoutDestination,
  payoutAmountString,
} from "../payout-amount";

describe("payoutAmountString", () => {
  it("renders units as a fixed 7-decimal string", () => {
    expect(payoutAmountString(25_000_000n)).toBe("2.5000000");
  });

  it("renders a single unit of dust without collapsing it to zero", () => {
    expect(payoutAmountString(1n)).toBe("0.0000001");
  });

  it("round-trips every rendered amount back to the exact same units", () => {
    for (const units of [1n, 7n, 25_000_000n, 999_999_999_999n, MAX_STELLAR_STROOPS]) {
      expect(usdcToUnits(payoutAmountString(units))).toBe(units);
    }
  });

  it("preserves a value that would lose precision as a float", () => {
    // 92_233_720_368.5477580 exceeds Number.MAX_SAFE_INTEGER in stroops, so any
    // float round-trip would drift. BigInt/string arithmetic must not.
    const units = 922_337_203_685_477_580n;
    expect(usdcToUnits(payoutAmountString(units))).toBe(units);
  });
});

describe("assertPayoutAmountUnits", () => {
  it("accepts a positive amount", () => {
    expect(() => assertPayoutAmountUnits(1n)).not.toThrow();
  });

  it("rejects a zero amount", () => {
    expect(() => assertPayoutAmountUnits(0n)).toThrow(/must be positive/i);
  });

  it("rejects a negative amount", () => {
    expect(() => assertPayoutAmountUnits(-1n)).toThrow(/must be positive/i);
  });

  it("rejects an amount above Stellar's int64 stroop ceiling", () => {
    expect(() => assertPayoutAmountUnits(MAX_STELLAR_STROOPS + 1n)).toThrow(
      /exceeds Stellar's maximum/i,
    );
  });

  it("accepts exactly the int64 stroop ceiling", () => {
    expect(() => assertPayoutAmountUnits(MAX_STELLAR_STROOPS)).not.toThrow();
  });

  it("names the field it rejected", () => {
    expect(() => assertPayoutAmountUnits(0n, "refund amount")).toThrow(/refund amount/);
  });
});

describe("assertPayoutDestination", () => {
  it("accepts a valid G… address", () => {
    const destination = Keypair.random().publicKey();
    expect(() => assertPayoutDestination(destination)).not.toThrow();
  });

  it("rejects a malformed address", () => {
    expect(() => assertPayoutDestination("not-an-address")).toThrow(
      /valid Stellar public key/i,
    );
  });

  it("rejects a muxed M… address, which the payout rail does not support", () => {
    expect(() =>
      assertPayoutDestination(
        "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK",
      ),
    ).toThrow(/valid Stellar public key/i);
  });
});
