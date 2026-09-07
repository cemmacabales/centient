import { Asset, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  extractAssetBalanceUnits,
  parseReserveRefillPolicy,
  planReserveRefill,
  stellarAmountToUnits,
} from "../reserve-refill";

function policyFixture() {
  const cold = Keypair.random();
  const hot = Keypair.random();
  const ops = Keypair.random();
  const policy = Keypair.random();
  const env: NodeJS.ProcessEnv = {
    STELLAR_COLD_RESERVE_ACCOUNT: cold.publicKey(),
    STELLAR_COLD_OPS_SIGNER_PUBLIC: ops.publicKey(),
    STELLAR_COLD_POLICY_SIGNER_PUBLIC: policy.publicKey(),
    STELLAR_PLATFORM_SECRET: hot.secret(),
    STELLAR_HOT_FLOAT_TRIGGER_UNITS: "250000000",
    STELLAR_HOT_FLOAT_TARGET_UNITS: "1000000000",
    STELLAR_COLD_MIN_RETAIN_UNITS: "500000000",
  };
  return { cold, hot, ops, policy, env };
}

describe("reserve refill policy", () => {
  it("parses exact unit limits and the true 2-of-3 signer set", () => {
    const { cold, hot, ops, policy, env } = policyFixture();

    expect(parseReserveRefillPolicy(env)).toEqual({
      coldAccount: cold.publicKey(),
      hotAccount: hot.publicKey(),
      signerPublicKeys: [
        cold.publicKey(),
        ops.publicKey(),
        policy.publicKey(),
      ],
      triggerUnits: 250_000_000n,
      targetUnits: 1_000_000_000n,
      minRetainUnits: 500_000_000n,
    });
  });

  it.each([
    "STELLAR_COLD_RESERVE_ACCOUNT",
    "STELLAR_COLD_OPS_SIGNER_PUBLIC",
    "STELLAR_COLD_POLICY_SIGNER_PUBLIC",
    "STELLAR_PLATFORM_SECRET",
    "STELLAR_HOT_FLOAT_TRIGGER_UNITS",
    "STELLAR_HOT_FLOAT_TARGET_UNITS",
    "STELLAR_COLD_MIN_RETAIN_UNITS",
  ])("fails closed when %s is missing", (name) => {
    const { env } = policyFixture();
    delete env[name];

    expect(() => parseReserveRefillPolicy(env)).toThrow(name);
  });

  it("rejects malformed account and signer public keys", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_COLD_RESERVE_ACCOUNT: "not-a-stellar-key",
      }),
    ).toThrow(/STELLAR_COLD_RESERVE_ACCOUNT/);
    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_COLD_OPS_SIGNER_PUBLIC: "not-a-stellar-key",
      }),
    ).toThrow(/STELLAR_COLD_OPS_SIGNER_PUBLIC/);
  });

  it("rejects malformed platform seeds", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_PLATFORM_SECRET: "not-a-stellar-seed",
      }),
    ).toThrow(/STELLAR_PLATFORM_SECRET/);
  });

  it.each([
    ["ops equals master", "STELLAR_COLD_OPS_SIGNER_PUBLIC", "cold"],
    ["policy equals master", "STELLAR_COLD_POLICY_SIGNER_PUBLIC", "cold"],
    ["policy equals ops", "STELLAR_COLD_POLICY_SIGNER_PUBLIC", "ops"],
    ["hot equals cold", "STELLAR_PLATFORM_SECRET", "coldSecret"],
  ])("rejects overlapping identities: %s", (_label, field, replacement) => {
    const { cold, ops, env } = policyFixture();
    const value =
      replacement === "cold"
        ? cold.publicKey()
        : replacement === "ops"
          ? ops.publicKey()
          : cold.secret();

    expect(() => parseReserveRefillPolicy({ ...env, [field]: value })).toThrow(
      /distinct/i,
    );
  });

  it.each(["-1", "1.5", " 1", "1 ", "abc", ""])(
    "rejects an unsafe unit setting %j",
    (value) => {
      const { env } = policyFixture();
      expect(() =>
        parseReserveRefillPolicy({
          ...env,
          STELLAR_HOT_FLOAT_TRIGGER_UNITS: value,
        }),
      ).toThrow(/STELLAR_HOT_FLOAT_TRIGGER_UNITS/);
    },
  );

  it("requires a positive target above the trigger", () => {
    const { env } = policyFixture();

    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_HOT_FLOAT_TRIGGER_UNITS: "0",
        STELLAR_HOT_FLOAT_TARGET_UNITS: "0",
      }),
    ).toThrow(/target/i);
    expect(() =>
      parseReserveRefillPolicy({
        ...env,
        STELLAR_HOT_FLOAT_TRIGGER_UNITS: "100",
        STELLAR_HOT_FLOAT_TARGET_UNITS: "100",
      }),
    ).toThrow(/greater than/i);
  });
});

describe("reserve refill balance parsing", () => {
  it("converts a large 7-decimal Stellar amount exactly", () => {
    expect(stellarAmountToUnits("123456789012.3456789")).toBe(
      1_234_567_890_123_456_789n,
    );
  });

  it.each(["-1", "1.00000001", "1e3", "NaN", " 1.0"])(
    "rejects an invalid Stellar amount %j",
    (amount) => {
      expect(() => stellarAmountToUnits(amount)).toThrow(/invalid Stellar amount/i);
    },
  );

  it("extracts only the configured asset code and issuer", () => {
    const issuer = Keypair.random().publicKey();
    const otherIssuer = Keypair.random().publicKey();
    const asset = new Asset("USDC", issuer);

    expect(
      extractAssetBalanceUnits(
        [
          { asset_type: "native", balance: "500.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: otherIssuer,
            balance: "99.0000000",
          },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: issuer,
            balance: "12.3456789",
          },
        ],
        asset,
      ),
    ).toBe(123_456_789n);
  });

  it("treats a missing configured trustline as zero", () => {
    const asset = new Asset("USDC", Keypair.random().publicKey());
    expect(
      extractAssetBalanceUnits(
        [{ asset_type: "native", balance: "500.0000000" }],
        asset,
      ),
    ).toBe(0n);
  });
});

describe("reserve refill plan", () => {
  it("does nothing while the hot float is above its trigger", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 300_000_000n, 2_000_000_000n)).toEqual({
      status: "healthy",
      hotBalanceUnits: 300_000_000n,
      coldBalanceUnits: 2_000_000_000n,
    });
  });

  it("restores the exact target when the hot float reaches the trigger", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 250_000_000n, 2_000_000_000n)).toEqual({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 2_000_000_000n,
      coldAfterUnits: 1_250_000_000n,
    });
  });

  it("allows an exact refill that leaves the retain floor intact", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 250_000_000n, 1_250_000_000n)).toEqual({
      status: "refill_required",
      amountUnits: 750_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 1_250_000_000n,
      coldAfterUnits: 500_000_000n,
    });
  });

  it("rejects a partial refill when the reserve cannot retain its floor", () => {
    const policy = parseReserveRefillPolicy(policyFixture().env);

    expect(planReserveRefill(policy, 250_000_000n, 1_000_000_000n)).toEqual({
      status: "insufficient_reserve",
      requiredUnits: 750_000_000n,
      availableUnits: 500_000_000n,
      hotBalanceUnits: 250_000_000n,
      coldBalanceUnits: 1_000_000_000n,
    });
  });
});
