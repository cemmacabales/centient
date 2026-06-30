import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  UNITS_PER_USDC,
  stellarNetwork,
  horizonUrl,
  networkPassphrase,
  explorerUrl,
  server,
  usdcToUnits,
  unitsToUsdcString,
  usdcAsset,
} from "@/lib/stellar/config";
import { Keypair, Networks } from "@stellar/stellar-sdk";

const ORIGINAL_ENV = { ...process.env };

// A throwaway but structurally valid issuer key (StrKey `G…`). Never funded.
const ISSUER = Keypair.random().publicKey();

beforeEach(() => {
  // Start each case from a known-clean slate so one test's override can't leak.
  delete process.env.STELLAR_NETWORK;
  delete process.env.STELLAR_HORIZON_URL;
  delete process.env.NEXT_PUBLIC_EXPLORER_URL;
  delete process.env.STELLAR_USDC_CODE;
  process.env.STELLAR_USDC_ISSUER = ISSUER;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("stellarNetwork", () => {
  it("defaults to testnet when unset", () => {
    expect(stellarNetwork()).toBe("testnet");
  });

  it("accepts public", () => {
    process.env.STELLAR_NETWORK = "public";
    expect(stellarNetwork()).toBe("public");
  });

  it("is case/whitespace tolerant", () => {
    process.env.STELLAR_NETWORK = "  Testnet  ";
    expect(stellarNetwork()).toBe("testnet");
  });

  it("throws on an unknown network", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    expect(() => stellarNetwork()).toThrow("STELLAR_NETWORK");
  });
});

describe("horizonUrl / networkPassphrase / explorerUrl", () => {
  it("uses testnet defaults", () => {
    expect(horizonUrl()).toBe("https://horizon-testnet.stellar.org");
    expect(networkPassphrase()).toBe(Networks.TESTNET);
    expect(explorerUrl()).toBe("https://stellar.expert/explorer/testnet");
  });

  it("uses public values when STELLAR_NETWORK=public", () => {
    process.env.STELLAR_NETWORK = "public";
    expect(horizonUrl()).toBe("https://horizon.stellar.org");
    expect(networkPassphrase()).toBe(Networks.PUBLIC);
    expect(explorerUrl()).toBe("https://stellar.expert/explorer/public");
  });

  it("honors STELLAR_HORIZON_URL override", () => {
    process.env.STELLAR_HORIZON_URL = "https://horizon.example.test";
    expect(horizonUrl()).toBe("https://horizon.example.test");
  });

  it("honors NEXT_PUBLIC_EXPLORER_URL override", () => {
    process.env.NEXT_PUBLIC_EXPLORER_URL = "https://explorer.example.test";
    expect(explorerUrl()).toBe("https://explorer.example.test");
  });
});

describe("server", () => {
  it("returns a Horizon server pointed at the active network", () => {
    const srv = server();
    expect(srv.serverURL.toString()).toContain("horizon-testnet.stellar.org");
  });
});

describe("usdcAsset", () => {
  it("builds the USDC asset from the configured issuer (default code)", () => {
    const asset = usdcAsset();
    expect(asset.getCode()).toBe("USDC");
    expect(asset.getIssuer()).toBe(ISSUER);
    expect(asset.isNative()).toBe(false);
  });

  it("honors a STELLAR_USDC_CODE override (e.g. USDCAllow)", () => {
    process.env.STELLAR_USDC_CODE = "USDCAllow";
    expect(usdcAsset().getCode()).toBe("USDCAllow");
  });

  it("throws when STELLAR_USDC_ISSUER is unset", () => {
    delete process.env.STELLAR_USDC_ISSUER;
    expect(() => usdcAsset()).toThrow("STELLAR_USDC_ISSUER");
  });

  it("throws when STELLAR_USDC_ISSUER is not a valid Stellar public key", () => {
    process.env.STELLAR_USDC_ISSUER = "not-a-key";
    expect(() => usdcAsset()).toThrow("STELLAR_USDC_ISSUER");
  });
});

describe("usdcToUnits", () => {
  it("converts whole USDC", () => {
    expect(usdcToUnits("1")).toBe(UNITS_PER_USDC);
    expect(usdcToUnits("10")).toBe(100_000_000n);
  });

  it("converts fractional USDC at full 7-dp precision", () => {
    expect(usdcToUnits("1.5")).toBe(15_000_000n);
    expect(usdcToUnits("0.0000001")).toBe(1n); // one stroop (dust)
    expect(usdcToUnits("0.1234567")).toBe(1_234_567n);
  });

  it("handles zero", () => {
    expect(usdcToUnits("0")).toBe(0n);
    expect(usdcToUnits("0.0000000")).toBe(0n);
  });

  it("keeps precision on large amounts (no float math)", () => {
    // 100,000,000 USDC — well past Number's safe-integer range once in units.
    expect(usdcToUnits("100000000.1234567")).toBe(1_000_000_001_234_567n);
  });

  it("rejects more than 7 decimal places", () => {
    expect(() => usdcToUnits("0.12345678")).toThrow("usdcToUnits");
  });

  it("rejects negative and non-numeric input", () => {
    expect(() => usdcToUnits("-1")).toThrow("usdcToUnits");
    expect(() => usdcToUnits("abc")).toThrow("usdcToUnits");
    expect(() => usdcToUnits("")).toThrow("usdcToUnits");
    expect(() => usdcToUnits("1.2.3")).toThrow("usdcToUnits");
  });
});

describe("unitsToUsdcString", () => {
  it("renders a fixed 7-decimal string", () => {
    expect(unitsToUsdcString(15_000_000n)).toBe("1.5000000");
    expect(unitsToUsdcString(1n)).toBe("0.0000001");
    expect(unitsToUsdcString(0n)).toBe("0.0000000");
    expect(unitsToUsdcString(100_000_000n)).toBe("10.0000000");
  });

  it("rejects negative units", () => {
    expect(() => unitsToUsdcString(-1n)).toThrow("unitsToUsdcString");
  });
});

describe("round-trip", () => {
  it("usdcToUnits ∘ unitsToUsdcString is identity over units", () => {
    const cases = [0n, 1n, 15_000_000n, 1_234_567n, 1_000_000_001_234_567n];
    for (const s of cases) {
      expect(usdcToUnits(unitsToUsdcString(s))).toBe(s);
    }
  });
});
