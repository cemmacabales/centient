import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// ST-3c (#297): dual-asset wallet-health for the pooled platform account.
// USDC is the payout float; XLM pays fees + base/trustline reserves. A USDC-only
// check would miss an XLM-starved account that can't submit any payout at all.

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"; // Circle testnet USDC issuer
const PLATFORM = Keypair.random();

const { mockLoadAccount } = vi.hoisted(() => ({ mockLoadAccount: vi.fn() }));

vi.mock("../config", async (importActual) => {
  const actual = await importActual<typeof import("../config")>();
  return {
    ...actual,
    server: () => ({ loadAccount: mockLoadAccount }),
  };
});

import {
  extractBalances,
  evaluateThresholds,
  parseBalanceThresholds,
  shouldFireAlert,
  recordAlertFired,
  getWalletHealth,
} from "../balance";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.STELLAR_USDC_ISSUER = ISSUER;
  process.env.STELLAR_PLATFORM_SECRET = PLATFORM.secret();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

type Line = { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string };

function balances(usdc: string | null, xlm: string): Line[] {
  const lines: Line[] = [{ asset_type: "native", balance: xlm }];
  if (usdc !== null) {
    lines.push({
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: ISSUER,
      balance: usdc,
    });
  }
  return lines;
}

describe("extractBalances", () => {
  it("reads the USDC float and native XLM from the account balances", () => {
    const { usdc, xlm } = extractBalances(balances("123.5000000", "42.0000000"));
    expect(usdc).toBe(123.5);
    expect(xlm).toBe(42);
  });

  it("treats a missing USDC trustline line as zero float", () => {
    const { usdc, xlm } = extractBalances(balances(null, "42.0000000"));
    expect(usdc).toBe(0);
    expect(xlm).toBe(42);
  });

  it("ignores a USDC-coded line from a different issuer (not our asset)", () => {
    const lines = [
      { asset_type: "native", balance: "10.0000000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GOTHER", balance: "999" },
    ];
    expect(extractBalances(lines).usdc).toBe(0);
  });
});

describe("evaluateThresholds", () => {
  const t = { warnUsdc: 50, pageUsdc: 10, warnXlm: 5, pageXlm: 2 };

  it("is healthy when both assets are above their warning thresholds", () => {
    const r = evaluateThresholds(10, 100, t);
    expect(r.healthy).toBe(true);
    expect(r.warnings).toHaveLength(0);
    expect(r.pages).toHaveLength(0);
  });

  it("pages on a low USDC float and names the float", () => {
    const r = evaluateThresholds(100, 5, t);
    expect(r.healthy).toBe(false);
    expect(r.pages.join(" ")).toMatch(/USDC/);
    expect(r.pages.join(" ")).toMatch(/float/i);
  });

  it("pages on a low XLM fee/reserve floor and names XLM", () => {
    const r = evaluateThresholds(1, 100, t);
    expect(r.healthy).toBe(false);
    expect(r.pages.join(" ")).toMatch(/XLM/);
    expect(r.pages.join(" ")).toMatch(/fee|reserve/i);
  });

  it("warns (not pages) when an asset is between page and warn", () => {
    const r = evaluateThresholds(3, 30, t);
    expect(r.pages).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("alert cooldown", () => {
  it("fires the first time and suppresses repeats within the window, per asset", () => {
    expect(shouldFireAlert("addr:USDC:PAGE")).toBe(true);
    recordAlertFired("addr:USDC:PAGE");
    expect(shouldFireAlert("addr:USDC:PAGE")).toBe(false);
    // A different asset's alert is independent.
    expect(shouldFireAlert("addr:XLM:PAGE")).toBe(true);
  });
});

describe("getWalletHealth", () => {
  it("reports both USDC float and XLM fee/reserve for the pooled account", async () => {
    mockLoadAccount.mockResolvedValueOnce({ balances: balances("500.0000000", "100.0000000") });

    const health = await getWalletHealth();

    expect(mockLoadAccount).toHaveBeenCalledWith(PLATFORM.publicKey());
    expect(health.usdcBalance).toBe("500.0000");
    expect(health.xlmBalance).toBe("100.0000");
    expect(health.healthy).toBe(true);
  });

  it("flags an unhealthy float when the USDC trustline line is missing (zero float)", async () => {
    mockLoadAccount.mockResolvedValueOnce({ balances: balances(null, "100.0000000") });

    const health = await getWalletHealth();

    expect(health.usdcBalance).toBe("0.0000");
    expect(health.healthy).toBe(false);
    expect(health.pages.join(" ")).toMatch(/USDC/);
  });
});
