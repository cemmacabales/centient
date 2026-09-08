import { describe, it, expect } from "vitest";
import {
  assertFixturePreconditions,
  QaFixtureGateError,
  requireDatabaseUrl,
  requireTestnet,
} from "../gate";

// These commands write payout rows and delete them again. Every case here is
// about refusing to do that against anything but a testnet.

const DB = "postgresql://postgres:postgres@localhost:5432/centient";

describe("requireTestnet", () => {
  it("accepts an explicit testnet", () => {
    expect(requireTestnet({ STELLAR_NETWORK: "testnet" })).toBe("testnet");
    expect(requireTestnet({ STELLAR_NETWORK: "  TESTNET  " })).toBe("testnet");
  });

  it("refuses the public network", () => {
    expect(() => requireTestnet({ STELLAR_NETWORK: "public" })).toThrow(QaFixtureGateError);
    expect(() => requireTestnet({ STELLAR_NETWORK: "public" })).toThrow(/testnet-only/);
  });

  it("refuses an unset network rather than defaulting to testnet", () => {
    // `stellarNetwork()` defaults to testnet, which is fine for a read path and
    // wrong for a destructive one. A command that deletes payout rows should
    // never infer which ledger it is pointed at.
    expect(() => requireTestnet({})).toThrow(/is not set/);
  });

  it("refuses an empty or whitespace network", () => {
    // The failure mode `resolvePayoutCoSigner` guards against: an empty string
    // slipping past a bare `!== "public"` comparison.
    expect(() => requireTestnet({ STELLAR_NETWORK: "" })).toThrow(/is not set/);
    expect(() => requireTestnet({ STELLAR_NETWORK: "   " })).toThrow(/is not set/);
  });

  it("refuses an unrecognised network", () => {
    expect(() => requireTestnet({ STELLAR_NETWORK: "futurenet" })).toThrow(/testnet-only/);
  });
});

describe("requireDatabaseUrl", () => {
  it("returns the configured url", () => {
    expect(requireDatabaseUrl({ DATABASE_URL: DB })).toBe(DB);
  });

  it("refuses an absent or empty url", () => {
    expect(() => requireDatabaseUrl({})).toThrow(/DATABASE_URL is not set/);
    expect(() => requireDatabaseUrl({ DATABASE_URL: "  " })).toThrow(/DATABASE_URL is not set/);
  });
});

describe("assertFixturePreconditions", () => {
  const env = { STELLAR_NETWORK: "testnet", DATABASE_URL: DB };

  it("passes when everything agrees", () => {
    expect(assertFixturePreconditions(env, "testnet")).toEqual({
      network: "testnet",
      databaseUrl: DB,
    });
  });

  it("passes when no manifest network is supplied", () => {
    expect(assertFixturePreconditions(env).network).toBe("testnet");
  });

  it("refuses a manifest provisioned for a different ledger", () => {
    // Those addresses do not exist on the configured network, so every fixture
    // would pay somewhere that cannot receive — a failure QA would reasonably
    // read as a rail defect.
    expect(() => assertFixturePreconditions(env, "public")).toThrow(
      /do not exist on the configured ledger/,
    );
  });

  it("checks the network before anything else", () => {
    expect(() =>
      assertFixturePreconditions({ STELLAR_NETWORK: "public", DATABASE_URL: DB }, "public"),
    ).toThrow(/testnet-only/);
  });
});
