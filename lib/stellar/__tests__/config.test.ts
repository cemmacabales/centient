import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  STROOPS_PER_XLM,
  stellarNetwork,
  horizonUrl,
  networkPassphrase,
  explorerUrl,
  server,
  xlmToStroops,
  stroopsToXlmString,
} from "@/lib/stellar/config";
import { Networks } from "@stellar/stellar-sdk";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Start each case from a known-clean slate so one test's override can't leak.
  delete process.env.STELLAR_NETWORK;
  delete process.env.STELLAR_HORIZON_URL;
  delete process.env.NEXT_PUBLIC_EXPLORER_URL;
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

describe("xlmToStroops", () => {
  it("converts whole XLM", () => {
    expect(xlmToStroops("1")).toBe(STROOPS_PER_XLM);
    expect(xlmToStroops("10")).toBe(100_000_000n);
  });

  it("converts fractional XLM at full 7-dp precision", () => {
    expect(xlmToStroops("1.5")).toBe(15_000_000n);
    expect(xlmToStroops("0.0000001")).toBe(1n); // one stroop (dust)
    expect(xlmToStroops("0.1234567")).toBe(1_234_567n);
  });

  it("handles zero", () => {
    expect(xlmToStroops("0")).toBe(0n);
    expect(xlmToStroops("0.0000000")).toBe(0n);
  });

  it("keeps precision on large amounts (no float math)", () => {
    // 100,000,000 XLM — well past Number's safe-integer range once in stroops.
    expect(xlmToStroops("100000000.1234567")).toBe(1_000_000_001_234_567n);
  });

  it("rejects more than 7 decimal places", () => {
    expect(() => xlmToStroops("0.12345678")).toThrow("xlmToStroops");
  });

  it("rejects negative and non-numeric input", () => {
    expect(() => xlmToStroops("-1")).toThrow("xlmToStroops");
    expect(() => xlmToStroops("abc")).toThrow("xlmToStroops");
    expect(() => xlmToStroops("")).toThrow("xlmToStroops");
    expect(() => xlmToStroops("1.2.3")).toThrow("xlmToStroops");
  });
});

describe("stroopsToXlmString", () => {
  it("renders a fixed 7-decimal string", () => {
    expect(stroopsToXlmString(15_000_000n)).toBe("1.5000000");
    expect(stroopsToXlmString(1n)).toBe("0.0000001");
    expect(stroopsToXlmString(0n)).toBe("0.0000000");
    expect(stroopsToXlmString(100_000_000n)).toBe("10.0000000");
  });

  it("rejects negative stroops", () => {
    expect(() => stroopsToXlmString(-1n)).toThrow("stroopsToXlmString");
  });
});

describe("round-trip", () => {
  it("xlmToStroops ∘ stroopsToXlmString is identity over stroops", () => {
    const cases = [0n, 1n, 15_000_000n, 1_234_567n, 1_000_000_001_234_567n];
    for (const s of cases) {
      expect(xlmToStroops(stroopsToXlmString(s))).toBe(s);
    }
  });
});
