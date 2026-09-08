import { afterEach, describe, expect, it } from "vitest";
import { assertIsolationPermitted, cosignerIsolationLevel } from "../cosigner-isolation";

const original = process.env.STELLAR_NETWORK;
afterEach(() => {
  if (original === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = original;
});

describe("cosignerIsolationLevel", () => {
  it("reads the two levels the deployment may declare", () => {
    expect(cosignerIsolationLevel({ COSIGNER_ISOLATION_LEVEL: "same-workspace" })).toBe(
      "same-workspace",
    );
    expect(cosignerIsolationLevel({ COSIGNER_ISOLATION_LEVEL: "separate-account" })).toBe(
      "separate-account",
    );
  });

  it("refuses an undeclared isolation level rather than assuming one", () => {
    // Defaulting here would pick the answer for whoever forgot to configure it,
    // and every wrong guess is silent: assume separate-account and a shared
    // workspace signs mainnet payouts; assume same-workspace and a correctly
    // isolated deployment is needlessly refused on public.
    expect(() => cosignerIsolationLevel({})).toThrow(/COSIGNER_ISOLATION_LEVEL/);
  });

  it("refuses an isolation level it does not recognise", () => {
    expect(() => cosignerIsolationLevel({ COSIGNER_ISOLATION_LEVEL: "airgapped" })).toThrow(
      /COSIGNER_ISOLATION_LEVEL/,
    );
  });
});

describe("assertIsolationPermitted", () => {
  it("permits the simulated boundary on testnet", () => {
    process.env.STELLAR_NETWORK = "testnet";
    expect(() =>
      assertIsolationPermitted({ COSIGNER_ISOLATION_LEVEL: "same-workspace" }),
    ).not.toThrow();
  });

  it("refuses the simulated boundary on the public network", () => {
    // ADR-0001 accepts one Railway account, one CI, and one database instance as
    // an MVP risk while no real funds move. On public that trade is no longer
    // available, and the refusal is here so it cannot be forgotten in a runbook.
    process.env.STELLAR_NETWORK = "public";
    expect(() =>
      assertIsolationPermitted({ COSIGNER_ISOLATION_LEVEL: "same-workspace" }),
    ).toThrow(/same-workspace/i);
  });

  it("permits a genuinely separate account on the public network", () => {
    process.env.STELLAR_NETWORK = "public";
    expect(() =>
      assertIsolationPermitted({ COSIGNER_ISOLATION_LEVEL: "separate-account" }),
    ).not.toThrow();
  });

  it("refuses an empty network rather than treating it as non-public", () => {
    process.env.STELLAR_NETWORK = "";
    expect(() =>
      assertIsolationPermitted({ COSIGNER_ISOLATION_LEVEL: "same-workspace" }),
    ).toThrow();
  });
});
