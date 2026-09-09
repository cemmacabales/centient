import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// ST-3c (#297): dual-asset wallet-health for the pooled platform account.
// USDC is the payout float; XLM pays fees + base/trustline reserves. A USDC-only
// check would miss an XLM-starved account that can't submit any payout at all.

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"; // Circle testnet USDC issuer
const PLATFORM = Keypair.random();

const { mockLoadAccount, mockLedgerCall, mockSendAlert } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockLedgerCall: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock("../config", async (importActual) => {
  const actual = await importActual<typeof import("../config")>();
  return {
    ...actual,
    server: () => ({
      loadAccount: mockLoadAccount,
      ledgers: () => ({
        order: () => ({ limit: () => ({ call: mockLedgerCall }) }),
      }),
    }),
  };
});

vi.mock("../../health-alert", () => ({
  sendDedupedDiscordAlert: mockSendAlert,
}));

import {
  parseBalanceThresholds,
  checkAndAlert,
  getWalletHealth,
  calculateSpendableXlm,
  evaluateStroopThresholds,
  xlmToStroops,
  TRUSTLINE_RESERVE_XLM,
} from "../balance";
import { walletBalanceAlerts } from "../../wallet-balance-alerts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.STELLAR_USDC_ISSUER = ISSUER;
  process.env.STELLAR_PLATFORM_SECRET = PLATFORM.secret();
  mockLedgerCall.mockResolvedValue({ records: [{ base_reserve_in_stroops: "5000000" }] });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

type Line = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
};

function balances(usdc: string | null, xlm: string): Line[] {
  const lines: Line[] = [{
    asset_type: "native",
    balance: xlm,
    selling_liabilities: "0.0000000",
  }];
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

describe("evaluateStroopThresholds", () => {
  const t = {
    warnUsdcStroops: 500_000_000n,
    pageUsdcStroops: 100_000_000n,
    warnXlmStroops: 50_000_000n,
    pageXlmStroops: 20_000_000n,
  };

  it("is healthy when both assets are above their warning thresholds", () => {
    const r = evaluateStroopThresholds({
      xlmStroops: 100_000_000n,
      usdcStroops: 1_000_000_000n,
      thresholds: t,
    });
    expect(r.healthy).toBe(true);
    expect(r.warnings).toHaveLength(0);
    expect(r.pages).toHaveLength(0);
  });

  it("pages on a low USDC float and names the float", () => {
    const r = evaluateStroopThresholds({
      xlmStroops: 1_000_000_000n,
      usdcStroops: 50_000_000n,
      thresholds: t,
    });
    expect(r.healthy).toBe(false);
    expect(r.assetStatus.usdc).toBe("page");
    expect(r.assetStatus.xlm).toBe("healthy");
    expect(r.pages.join(" ")).toMatch(/USDC/);
    expect(r.pages.join(" ")).toMatch(/float/i);
  });

  it("pages on a low XLM fee/reserve floor and names XLM", () => {
    const r = evaluateStroopThresholds({
      xlmStroops: 10_000_000n,
      usdcStroops: 1_000_000_000n,
      thresholds: t,
    });
    expect(r.healthy).toBe(false);
    expect(r.assetStatus.usdc).toBe("healthy");
    expect(r.assetStatus.xlm).toBe("page");
    expect(r.pages.join(" ")).toMatch(/XLM/);
    expect(r.pages.join(" ")).toMatch(/fee|reserve/i);
  });

  it("warns (not pages) when an asset is between page and warn", () => {
    const r = evaluateStroopThresholds({
      xlmStroops: 30_000_000n,
      usdcStroops: 300_000_000n,
      thresholds: t,
    });
    expect(r.pages).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("checkAndAlert", () => {
  it("sends distinct alerts when both the USDC and spendable XLM balances are low", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: balances("5.0000000", "1.0000000"),
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    });
    mockSendAlert.mockResolvedValue("sent");

    await checkAndAlert();

    expect(mockSendAlert).toHaveBeenCalledTimes(2);
    expect(mockSendAlert.mock.calls.map(([alert]) => alert.key)).toEqual([
      "wallet-usdc-page",
      "wallet-xlm-page",
    ]);
  });
});

describe("getWalletHealth", () => {
  it("reports both USDC float and XLM fee/reserve for the pooled account", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: balances("500.0000000", "100.0000000"),
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    });

    const health = await getWalletHealth();

    expect(mockLoadAccount).toHaveBeenCalledWith(PLATFORM.publicKey());
    expect(health.usdcBalance).toBe("500.0000");
    expect(health.xlmBalance).toBe("100.0000");
    expect(health.availableXlmBalance).toBe("99.0000");
    expect(health.healthy).toBe(true);
  });

  it("flags an unhealthy float when the USDC trustline line is missing (zero float)", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: balances(null, "100.0000000"),
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    });

    const health = await getWalletHealth();

    expect(health.usdcBalance).toBe("0.0000");
    expect(health.healthy).toBe(false);
    expect(health.pages.join(" ")).toMatch(/USDC/);
  });
});

describe("getWalletHealth sponsored-reserve accounting", () => {
  it("subtracts 0.5 XLM per num_sponsoring from the XLM floor", async () => {
    // 6 XLM raw with 10 sponsored reserve units requires 6 XLM total once the
    // base account reserve is included, leaving zero spendable XLM.
    mockLoadAccount.mockResolvedValue({
      subentry_count: 0,
      num_sponsoring: 10,
      num_sponsored: 0,
      balances: [
        { asset_type: "native", balance: "6.0000000", selling_liabilities: "0.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "100.0" },
      ],
    });
    const health = await getWalletHealth();
    expect(TRUSTLINE_RESERVE_XLM).toBe(0.5);
    expect(health.numSponsoring).toBe(10);
    expect(health.sponsoredReserveXlm).toBe("5.0000");
    expect(health.availableXlmBalance).toBe("0.0000");
    expect(health.healthy).toBe(false);
    expect(health.pages.join(" ")).toMatch(/XLM/);
  });

  it("treats missing reserve counts as a Horizon monitoring error", async () => {
    mockLoadAccount.mockResolvedValue({
      balances: [{ asset_type: "native", balance: "50.0" }],
    });
    const health = await getWalletHealth();
    expect(health.monitoringStatus).toBe("error");
    expect(health.xlmBalance).toBe("—");
    expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
  });
});

describe("optional balance threshold normalization", () => {
  it("falls back to the documented defaults for malformed optional thresholds", () => {
    process.env.BALANCE_WARN_USDC = "fifty";
    process.env.BALANCE_PAGE_USDC = "";
    process.env.BALANCE_WARN_XLM = "-5";
    process.env.BALANCE_PAGE_XLM = "2.00000001";

    expect(parseBalanceThresholds()).toEqual({
      warnUsdc: 50,
      pageUsdc: 10,
      warnXlm: 5,
      pageXlm: 2,
    });
  });

  it("keeps Horizon monitoring live and compares against the normalized default", async () => {
    process.env.BALANCE_WARN_USDC = "fifty";
    mockLoadAccount.mockResolvedValue({
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
      balances: balances("40.0000000", "100.0000000"),
    });

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("healthy");
    expect(health.thresholds.warnUsdc).toBe(50);
    expect(health.assetStatus.usdc).toBe("warn");
    expect(health.warnings.join(" ")).toContain("below warning threshold 50.00 USDC");
    expect(health.warnings.join(" ")).not.toMatch(/Horizon/);
  });
});

describe("wallet monitoring diagnostics", () => {
  it("logs the error class for a Horizon failure without leaking its message", async () => {
    const secret = "synthetic-horizon-credential";
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoadAccount.mockRejectedValue(new Error(`https://user:${secret}@horizon/accounts`));

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("error");
    expect(logs).toHaveBeenCalled();
    expect(logs.mock.calls.flat().some((value) => typeof value === "object")).toBe(false);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logs.mock.calls)).toContain("Horizon wallet monitoring unavailable");
    logs.mockRestore();
  });

  it("distinguishes an unusable configured asset from a Horizon failure", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STELLAR_USDC_ISSUER = "not-a-valid-issuer";

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("unconfigured");
    expect(JSON.stringify(logs.mock.calls)).toContain("configured USDC asset unusable");
    logs.mockRestore();
  });
});

describe("Horizon request deadline", () => {
  it("reports a monitoring error when Horizon never answers", async () => {
    vi.useFakeTimers();
    try {
      mockLoadAccount.mockImplementation(() => new Promise(() => {}));

      let health: Awaited<ReturnType<typeof getWalletHealth>> | undefined;
      const pending = getWalletHealth().then((result) => {
        health = result;
      });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(health?.monitoringStatus).toBe("error");
      expect(health?.usdcBalance).toBe("—");
      expect(health?.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wallet reserve count availability", () => {
  it("reports reserve counts as null when the platform wallet is unconfigured", async () => {
    delete process.env.STELLAR_PLATFORM_SECRET;

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("unconfigured");
    expect(health.numSubentries).toBeNull();
    expect(health.numSponsoring).toBeNull();
    expect(health.numSponsored).toBeNull();
  });

  it("reports reserve counts as null when Horizon monitoring is unavailable", async () => {
    mockLoadAccount.mockResolvedValue({ balances: [{ asset_type: "native", balance: "50.0" }] });

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("error");
    expect(health.numSubentries).toBeNull();
    expect(health.numSponsoring).toBeNull();
    expect(health.numSponsored).toBeNull();
  });
});

describe("calculateSpendableXlm", () => {
  it("subtracts live protocol reserves and native selling liabilities", () => {
    const result = calculateSpendableXlm({
      totalStroops: 100_000_000n,
      sellingLiabilitiesStroops: 10_000_000n,
      baseReserveStroops: 5_000_000n,
      subentryCount: 2,
      numSponsoring: 3,
      numSponsored: 1,
    });

    expect(result).toEqual({ minimumBalanceStroops: 30_000_000n, spendableStroops: 60_000_000n });
  });

  it("offsets sponsored entries against the reserve requirement", () => {
    const result = calculateSpendableXlm({
      totalStroops: 100_000_000n,
      sellingLiabilitiesStroops: 0n,
      baseReserveStroops: 5_000_000n,
      subentryCount: 0,
      numSponsoring: 0,
      numSponsored: 5,
    });

    expect(result.minimumBalanceStroops).toBe(0n);
  });

  it("preserves all seven Stellar decimal places when parsing Horizon amounts", () => {
    expect(xlmToStroops("10.1234567")).toBe(101_234_567n);
  });

  it("floors overspent XLM at zero", () => {
    const result = calculateSpendableXlm({
      totalStroops: 10_000_000n,
      sellingLiabilitiesStroops: 5_000_000n,
      baseReserveStroops: 5_000_000n,
      subentryCount: 2,
      numSponsoring: 0,
      numSponsored: 0,
    });

    expect(result.spendableStroops).toBe(0n);
  });

  it("compares an unsafe-integer XLM threshold in exact stroops", () => {
    const balanceAtWarnBoundary = 9_007_199_254_740_993n;
    const result = evaluateStroopThresholds({
      xlmStroops: balanceAtWarnBoundary,
      usdcStroops: 1_000_000_000n,
      thresholds: {
        warnUsdcStroops: 500_000_000n,
        pageUsdcStroops: 100_000_000n,
        warnXlmStroops: balanceAtWarnBoundary,
        pageXlmStroops: balanceAtWarnBoundary - 1n,
      },
    });

    expect(result.assetStatus.xlm).toBe("warn");
  });
});

describe("getWalletHealth protocol reserve data", () => {
  it("uses the latest Horizon ledger and account liabilities for spendable XLM", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: [
        { asset_type: "native", balance: "10.0000000", selling_liabilities: "1.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "100.0000000" },
      ],
      subentry_count: 2,
      num_sponsoring: 3,
      num_sponsored: 1,
    });

    const health = await getWalletHealth();

    expect(health.baseReserveXlm).toBe("0.5000");
    expect(health.minimumBalanceXlm).toBe("3.0000");
    expect(health.nativeSellingLiabilitiesXlm).toBe("1.0000");
    expect(health.availableXlmBalance).toBe("6.0000");
    expect(health.numSubentries).toBe(2);
    expect(health.numSponsoring).toBe(3);
    expect(health.numSponsored).toBe(1);
    expect(health.monitoringStatus).toBe("healthy");
  });

  it("matches the USDC balance by configured code and issuer", async () => {
    process.env.STELLAR_USDC_CODE = "EURC";
    mockLoadAccount.mockResolvedValueOnce({
      balances: [
        { asset_type: "native", balance: "100.0000000", selling_liabilities: "0.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "999.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: ISSUER, balance: "100.0000000" },
      ],
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    });

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("healthy");
    expect(health.usdcBalance).toBe("100.0000");
  });

  it.each([
    ["missing issuer", undefined],
    ["invalid issuer", "not-a-stellar-issuer"],
  ])("marks a %s configuration as unconfigured", async (_description, issuer) => {
    if (issuer === undefined) delete process.env.STELLAR_USDC_ISSUER;
    else process.env.STELLAR_USDC_ISSUER = issuer;

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("unconfigured");
    expect(health.usdcBalance).toBe("—");
    expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
  });

  it.each([
    ["subentry_count", { num_sponsoring: 0, num_sponsored: 0 }],
    ["num_sponsoring", { subentry_count: 0, num_sponsored: 0 }],
    ["num_sponsored", { subentry_count: 0, num_sponsoring: 0 }],
  ])("marks a missing %s as an error", async (_field, counts) => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: balances("100.0000000", "100.0000000"),
      ...counts,
    });

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("error");
    expect(health.xlmBalance).toBe("—");
    expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
  });

  it("marks a missing native selling liability as an error", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: [{ asset_type: "native", balance: "100.0000000" }],
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    });

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("error");
    expect(health.xlmBalance).toBe("—");
    expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
  });

  it("marks malformed configured-USDC data as an error", async () => {
    mockLoadAccount.mockResolvedValueOnce({
      balances: [
        { asset_type: "native", balance: "100.0000000", selling_liabilities: "0.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "not-a-balance" },
      ],
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
    });

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("error");
    expect(health.usdcBalance).toBe("—");
    expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
  });

  it("marks absent or invalid wallet configuration as unconfigured without inventing balances", async () => {
    delete process.env.STELLAR_PLATFORM_SECRET;
    const missing = await getWalletHealth();

    process.env.STELLAR_PLATFORM_SECRET = "not-a-stellar-secret";
    const invalid = await getWalletHealth();

    for (const health of [missing, invalid]) {
      expect(health.monitoringStatus).toBe("unconfigured");
      expect(health.usdcBalance).toBe("—");
      expect(health.xlmBalance).toBe("—");
      expect(health.availableXlmBalance).toBe("—");
      expect(health.baseReserveXlm).toBe("—");
      expect(health.minimumBalanceXlm).toBe("—");
      expect(health.nativeSellingLiabilitiesXlm).toBe("—");
      expect(health.sponsoredReserveXlm).toBe("—");
      expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
    }
  });

  it("marks Horizon failures as errors without inventing balances", async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error("Horizon unavailable"));

    const health = await getWalletHealth();

    expect(health.monitoringStatus).toBe("error");
    expect(health.usdcBalance).toBe("—");
    expect(health.xlmBalance).toBe("—");
    expect(health.availableXlmBalance).toBe("—");
    expect(health.baseReserveXlm).toBe("—");
    expect(health.minimumBalanceXlm).toBe("—");
    expect(health.nativeSellingLiabilitiesXlm).toBe("—");
    expect(health.sponsoredReserveXlm).toBe("—");
    expect(health.assetStatus).toEqual({ usdc: "unknown", xlm: "unknown" });
  });
});

describe("walletBalanceAlerts monitoring states", () => {
  it("emits a warning source alert when monitoring is unconfigured", () => {
    expect(
      walletBalanceAlerts({
        address: "—",
        availableXlmBalance: "—",
        usdcBalance: "—",
        assetStatus: { usdc: "unknown", xlm: "unknown" },
        monitoringStatus: "unconfigured",
      }),
    ).toMatchObject([{ key: "wallet-monitoring-unconfigured", severity: "WARN" }]);
  });

  it("emits a page source alert when monitoring is unavailable", () => {
    expect(
      walletBalanceAlerts({
        address: PLATFORM.publicKey(),
        availableXlmBalance: "—",
        usdcBalance: "—",
        assetStatus: { usdc: "unknown", xlm: "unknown" },
        monitoringStatus: "error",
      }),
    ).toMatchObject([{ key: "wallet-monitoring-unavailable", severity: "PAGE" }]);
  });

  it("describes the exact minimum balance and selling liabilities for low XLM", () => {
    const [alert] = walletBalanceAlerts({
      address: PLATFORM.publicKey(),
      availableXlmBalance: "6.0000",
      minimumBalanceXlm: "3.0000",
      nativeSellingLiabilitiesXlm: "1.0000",
      usdcBalance: "100.0000",
      assetStatus: { usdc: "healthy", xlm: "page" },
      monitoringStatus: "healthy",
    });

    expect(alert.lines[0]).toContain("3.0000 XLM minimum balance");
    expect(alert.lines[0]).toContain("1.0000 XLM selling liabilities");
    expect(alert.lines[0]).not.toContain("reserved");
  });
});
