import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { expiringNonceStore, resolveCoSignerConfig } from "../cosigner-config";

const policy = Keypair.random();

const baseEnv = {
  COSIGNER_SHARED_SECRET: "a".repeat(32),
  COSIGNER_DAILY_CAP_UNITS: "200000000000",
  COSIGNER_ISOLATION_LEVEL: "same-workspace",
  COSIGNER_DATABASE_URL: "postgresql://readonly@db/centient",
  STELLAR_POLICY_SIGNER_SECRET: policy.secret(),
};

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

describe("resolveCoSignerConfig", () => {
  it("resolves a fully configured co-signer deployment", () => {
    const config = resolveCoSignerConfig(baseEnv);

    expect(config.policy.publicKey()).toBe(policy.publicKey());
    expect(config.capUnits).toBe(200_000_000_000n);
    expect(config.databaseUrl).toBe("postgresql://readonly@db/centient");
  });

  it("refuses to start without the policy signing key it exists to hold", () => {
    expect(() =>
      resolveCoSignerConfig({ ...baseEnv, STELLAR_POLICY_SIGNER_SECRET: undefined }),
    ).toThrow(/STELLAR_POLICY_SIGNER_SECRET/);
  });

  it("refuses to start without its own database credential", () => {
    // Falling back to DATABASE_URL would silently hand the co-signer the
    // application's read-write connection and dissolve the separation it exists
    // to provide, so there is deliberately no fallback.
    expect(() =>
      resolveCoSignerConfig({ ...baseEnv, COSIGNER_DATABASE_URL: undefined }),
    ).toThrow(/COSIGNER_DATABASE_URL/);
  });

  it("refuses to start without its own cap, rather than inheriting the app's", () => {
    // A cap defaulted from DAILY_PAYOUT_CAP_UNITS would make the second check the
    // same check, and #9 asks for an independent one.
    expect(() =>
      resolveCoSignerConfig({ ...baseEnv, COSIGNER_DAILY_CAP_UNITS: undefined }),
    ).toThrow(/COSIGNER_DAILY_CAP_UNITS/);
  });

  it("refuses a cap that is not a positive integer number of units", () => {
    for (const capUnits of ["0", "-1", "2.5", "lots"]) {
      expect(() => resolveCoSignerConfig({ ...baseEnv, COSIGNER_DAILY_CAP_UNITS: capUnits })).toThrow(
        /COSIGNER_DAILY_CAP_UNITS/,
      );
    }
  });

  it("refuses to start under a topology this network does not permit", () => {
    process.env.STELLAR_NETWORK = "public";
    expect(() => resolveCoSignerConfig(baseEnv)).toThrow(/same-workspace/i);
  });

  it("refuses a policy secret that is not the advertised co-signer key", () => {
    expect(() =>
      resolveCoSignerConfig({
        ...baseEnv,
        STELLAR_POLICY_SIGNER_PUBLIC: Keypair.random().publicKey(),
      }),
    ).toThrow(/does not match/i);
  });
});

describe("expiringNonceStore", () => {
  it("accepts a nonce once and refuses it thereafter", () => {
    const store = expiringNonceStore();

    expect(store.take("n1")).toBe(true);
    expect(store.take("n1")).toBe(false);
  });

  it("forgets a nonce once it is older than the replay window", () => {
    // Memory is bounded by the freshness window: a nonce older than the window
    // can no longer be replayed, because the timestamp check rejects it first.
    let now = 1_000_000;
    const store = expiringNonceStore(() => now);

    expect(store.take("n1")).toBe(true);
    now += 60 * 60_000;
    expect(store.take("n1")).toBe(true);
  });
});
