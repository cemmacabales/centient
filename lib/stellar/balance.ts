// Dual-asset wallet-health for the pooled platform account (ST-3c #297).
// Replaces lib/celo-balance.ts. USDC is non-native, so the pooled account holds
// TWO balances that both matter:
//   - USDC — the payout float; if it runs low, withdrawals can't be funded.
//   - XLM  — pays every transaction's fee + the base/trustline reserves; if it
//            runs low, NO payout can be submitted even with USDC on hand.
// A USDC-only check would silently strand payouts on an XLM-starved account, so
// both assets get their own thresholds. The Discord alert + cooldown mechanism is
// preserved from celo-balance; alerts say which asset crossed its threshold.
import { Keypair } from "@stellar/stellar-sdk";
import { REWARD_TOKEN_SYMBOL } from "../constants";
import { sendDedupedDiscordAlert } from "../health-alert";
import { walletBalanceAlerts } from "../wallet-balance-alerts";
import { server, usdcAsset, usdcToUnits } from "./config";

/**
 * @deprecated Reserve requirements are read from Horizon's latest ledger. This
 * export remains for existing callers until they move to `baseReserveXlm`.
 */
export const TRUSTLINE_RESERVE_XLM = 0.5;
const STROOPS_PER_XLM = 10_000_000n;

/** Balance line as returned by Horizon `account.balances[]` (subset we read). */
interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
}

function platformPublicKey(): string | null {
  const secret = process.env.STELLAR_PLATFORM_SECRET;
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    // A malformed/placeholder secret must not crash every route that imports this
    // module at load time (status-health page, /api/health/wallet, workers).
    // Treat it like an unconfigured wallet so health checks degrade gracefully.
    console.warn(
      "[stellar/balance] STELLAR_PLATFORM_SECRET is set but not a valid secret — treating wallet as unconfigured",
    );
    return null;
  }
}

export interface BalanceThresholds {
  /** USDC payout float. */
  warnUsdc: number;
  pageUsdc: number;
  /** XLM fee/reserve floor. */
  warnXlm: number;
  pageXlm: number;
}

export interface WalletHealth {
  address: string;
  monitoringStatus: WalletMonitoringStatus;
  /** USDC payout float. */
  usdcBalance: string;
  /** XLM held for fees + base/trustline reserves. */
  xlmBalance: string;
  /** XLM available after native selling liabilities and protocol reserves. */
  availableXlmBalance: string;
  /** Live network reserve, rendered for operators. */
  baseReserveXlm: string;
  /** Protocol-required minimum account balance, rendered for operators. */
  minimumBalanceXlm: string;
  /** Native XLM committed to offers, rendered for operators. */
  nativeSellingLiabilitiesXlm: string;
  /** Account entries that consume reserve units; null when unavailable. */
  numSubentries: number | null;
  /** Trustlines the platform sponsors (Horizon num_sponsoring); null when unavailable. */
  numSponsoring: number | null;
  /** Reserve units sponsored by another account (Horizon num_sponsored); null when unavailable. */
  numSponsored: number | null;
  /** Live-reserve cost attributable to outgoing sponsorships, informational. */
  sponsoredReserveXlm: string;
  rewardTokenSymbol: string;
  healthy: boolean;
  warnings: string[];
  pages: string[];
  assetStatus: {
    usdc: BalanceStatus;
    xlm: BalanceStatus;
  };
  thresholds: BalanceThresholds;
}

export type BalanceStatus = "healthy" | "warn" | "page" | "unknown";
export type WalletMonitoringStatus = "healthy" | "unconfigured" | "error";

export interface SpendableXlmInput {
  totalStroops: bigint;
  sellingLiabilitiesStroops: bigint;
  baseReserveStroops: bigint;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
}

/** Convert Horizon's non-negative, seven-decimal XLM strings into stroops. */
export function xlmToStroops(xlm: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(xlm.trim());
  if (!match) {
    throw new Error(`Invalid Horizon XLM amount: ${xlm}`);
  }
  return BigInt(match[1]) * STROOPS_PER_XLM + BigInt((match[2] ?? "").padEnd(7, "0"));
}

function stroopsToDisplay(stroops: bigint, decimalPlaces = 4): string {
  if (stroops < 0n) throw new Error("XLM stroops must be non-negative");
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole}.${fraction.slice(0, decimalPlaces)}`;
}

function countFromHorizon(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`Invalid Horizon ${name}`);
}

function baseReserveStroopsFromLedger(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  throw new Error("Invalid Horizon base_reserve_in_stroops");
}

export function calculateSpendableXlm({
  totalStroops,
  sellingLiabilitiesStroops,
  baseReserveStroops,
  subentryCount,
  numSponsoring,
  numSponsored,
}: SpendableXlmInput): { minimumBalanceStroops: bigint; spendableStroops: bigint } {
  const reserveUnits = Math.max(0, 2 + subentryCount + numSponsoring - numSponsored);
  const minimumBalanceStroops = baseReserveStroops * BigInt(reserveUnits);
  const raw = totalStroops - sellingLiabilitiesStroops - minimumBalanceStroops;
  return { minimumBalanceStroops, spendableStroops: raw > 0n ? raw : 0n };
}

/**
 * Documented defaults for the optional balance thresholds. The XLM floor covers
 * fees + the account's base reserve + every trustline reserve; sponsored
 * recipient trustlines are subtracted from the balance in getWalletHealth
 * (ST-4e #314), so the XLM threshold stays fee-oriented.
 */
const DEFAULT_BALANCE_THRESHOLDS = {
  BALANCE_WARN_USDC: "50",
  BALANCE_PAGE_USDC: "10",
  BALANCE_WARN_XLM: "5",
  BALANCE_PAGE_XLM: "2",
} as const;

type BalanceThresholdName = keyof typeof DEFAULT_BALANCE_THRESHOLDS;

/**
 * A malformed optional threshold is an operator configuration mistake, not a
 * Horizon outage: fall back to the documented default instead of failing the
 * whole wallet check. Normalization happens once, in stroops, and every exact
 * comparison and rendered value is derived from the same normalized value.
 */
function thresholdStroops(name: BalanceThresholdName, env: BalanceEnvironment): bigint {
  const fallback = DEFAULT_BALANCE_THRESHOLDS[name];
  const raw = env[name];
  if (raw === undefined) return xlmToStroops(fallback);
  try {
    return xlmToStroops(raw);
  } catch {
    console.warn(
      `[stellar/balance] ${name} is not a valid non-negative amount — using default ${fallback}`,
    );
    return xlmToStroops(fallback);
  }
}

type BalanceEnvironment = Readonly<Record<string, string | undefined>>;

export function parseBalanceThresholdStroops(
  env: BalanceEnvironment = process.env,
): StroopThresholds {
  return {
    warnUsdcStroops: thresholdStroops("BALANCE_WARN_USDC", env),
    pageUsdcStroops: thresholdStroops("BALANCE_PAGE_USDC", env),
    warnXlmStroops: thresholdStroops("BALANCE_WARN_XLM", env),
    pageXlmStroops: thresholdStroops("BALANCE_PAGE_XLM", env),
  };
}

/** Display view of the same normalized thresholds used for exact comparisons. */
export function parseBalanceThresholds(env: BalanceEnvironment = process.env): BalanceThresholds {
  const stroops = parseBalanceThresholdStroops(env);
  return {
    warnUsdc: Number(stroops.warnUsdcStroops) / Number(STROOPS_PER_XLM),
    pageUsdc: Number(stroops.pageUsdcStroops) / Number(STROOPS_PER_XLM),
    warnXlm: Number(stroops.warnXlmStroops) / Number(STROOPS_PER_XLM),
    pageXlm: Number(stroops.pageXlmStroops) / Number(STROOPS_PER_XLM),
  };
}

/**
 * Pull the two balances that matter out of a Horizon `balances[]` array: the
 * native XLM line and the configured payout-asset line (matched by the exact
 * code and issuer validated by `usdcAsset()`). A missing configured asset line
 * means no trustline / no float — reported as 0 and treated as low downstream.
 */
export function extractBalances(balances: HorizonBalanceLine[]): { xlm: number; usdc: number } {
  const asset = usdcAsset();
  const issuer = asset.getIssuer();
  if (!issuer) throw new Error("Configured USDC asset has no issuer");

  const native = balances.find((b) => b.asset_type === "native");
  const usdcLine = balances.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_code === asset.getCode() &&
      b.asset_issuer === issuer,
  );

  return {
    xlm: native ? Number(native.balance) : 0,
    usdc: usdcLine ? Number(usdcToUnits(usdcLine.balance)) / Number(STROOPS_PER_XLM) : 0,
  };
}

export interface StroopThresholds {
  warnUsdcStroops: bigint;
  pageUsdcStroops: bigint;
  warnXlmStroops: bigint;
  pageXlmStroops: bigint;
}

export function evaluateStroopThresholds({
  xlmStroops,
  usdcStroops,
  thresholds,
}: {
  xlmStroops: bigint;
  usdcStroops: bigint;
  thresholds: StroopThresholds;
}): {
  healthy: boolean;
  warnings: string[];
  pages: string[];
  assetStatus: { usdc: BalanceStatus; xlm: BalanceStatus };
} {
  const warnings: string[] = [];
  const pages: string[] = [];
  const assetStatus: { usdc: BalanceStatus; xlm: BalanceStatus } = {
    usdc: "healthy",
    xlm: "healthy",
  };

  if (usdcStroops <= thresholds.pageUsdcStroops) {
    assetStatus.usdc = "page";
    pages.push(
      `USDC float ${stroopsToDisplay(usdcStroops, 2)} USDC is below page threshold ${stroopsToDisplay(thresholds.pageUsdcStroops, 2)} USDC`,
    );
  } else if (usdcStroops <= thresholds.warnUsdcStroops) {
    assetStatus.usdc = "warn";
    warnings.push(
      `USDC float ${stroopsToDisplay(usdcStroops, 2)} USDC is below warning threshold ${stroopsToDisplay(thresholds.warnUsdcStroops, 2)} USDC`,
    );
  }

  if (xlmStroops <= thresholds.pageXlmStroops) {
    assetStatus.xlm = "page";
    pages.push(
      `XLM fee/reserve balance ${stroopsToDisplay(xlmStroops)} XLM is below page threshold ${stroopsToDisplay(thresholds.pageXlmStroops)} XLM`,
    );
  } else if (xlmStroops <= thresholds.warnXlmStroops) {
    assetStatus.xlm = "warn";
    warnings.push(
      `XLM fee/reserve balance ${stroopsToDisplay(xlmStroops)} XLM is below warning threshold ${stroopsToDisplay(thresholds.warnXlmStroops)} XLM`,
    );
  }

  return {
    healthy: warnings.length === 0 && pages.length === 0,
    warnings,
    pages,
    assetStatus,
  };
}

export async function getWalletHealth(): Promise<WalletHealth> {
  const thresholdStroops = parseBalanceThresholdStroops();
  const thresholds = parseBalanceThresholds();
  const address = platformPublicKey();

  if (!address) {
    return {
      address: "—",
      monitoringStatus: "unconfigured",
      usdcBalance: "—",
      xlmBalance: "—",
      availableXlmBalance: "—",
      baseReserveXlm: "—",
      minimumBalanceXlm: "—",
      nativeSellingLiabilitiesXlm: "—",
      numSubentries: null,
      numSponsoring: null,
      numSponsored: null,
      sponsoredReserveXlm: "—",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["STELLAR_PLATFORM_SECRET not configured"],
      pages: [],
      assetStatus: { usdc: "unknown", xlm: "unknown" },
      thresholds,
    };
  }

  let configuredUsdcCode: string;
  let configuredUsdcIssuer: string;
  try {
    const asset = usdcAsset();
    const issuer = asset.getIssuer();
    if (!issuer) throw new Error("Configured USDC asset has no issuer");
    configuredUsdcCode = asset.getCode();
    configuredUsdcIssuer = issuer;
  } catch {
    return {
      address,
      monitoringStatus: "unconfigured",
      usdcBalance: "—",
      xlmBalance: "—",
      availableXlmBalance: "—",
      baseReserveXlm: "—",
      minimumBalanceXlm: "—",
      nativeSellingLiabilitiesXlm: "—",
      numSubentries: null,
      numSponsoring: null,
      numSponsored: null,
      sponsoredReserveXlm: "—",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["STELLAR USDC asset not configured"],
      pages: [],
      assetStatus: { usdc: "unknown", xlm: "unknown" },
      thresholds,
    };
  }

  let totalStroops: bigint;
  let sellingLiabilitiesStroops: bigint;
  let baseReserveStroops: bigint;
  let usdcStroops: bigint;
  let numSubentries: number;
  let numSponsoring: number;
  let numSponsored: number;
  try {
    const horizon = server();
    const [account, ledgerPage] = await Promise.all([
      horizon.loadAccount(address),
      horizon.ledgers().order("desc").limit(1).call(),
    ]);
    const native = (account.balances as HorizonBalanceLine[]).find(
      (balance) => balance.asset_type === "native",
    );
    const latestLedger = ledgerPage.records[0];
    if (!native || !latestLedger) throw new Error("Horizon account or latest ledger is incomplete");

    totalStroops = xlmToStroops(native.balance);
    if (native.selling_liabilities === undefined) {
      throw new Error("Horizon native selling_liabilities is missing");
    }
    sellingLiabilitiesStroops = xlmToStroops(native.selling_liabilities);
    baseReserveStroops = baseReserveStroopsFromLedger(latestLedger.base_reserve_in_stroops);
    numSubentries = countFromHorizon(account.subentry_count, "subentry_count");
    numSponsoring = countFromHorizon(account.num_sponsoring, "num_sponsoring");
    numSponsored = countFromHorizon(account.num_sponsored, "num_sponsored");
    const usdcLine = (account.balances as HorizonBalanceLine[]).find(
      (balance) =>
        balance.asset_type !== "native" &&
        balance.asset_code === configuredUsdcCode &&
        balance.asset_issuer === configuredUsdcIssuer,
    );
    usdcStroops = usdcLine ? usdcToUnits(usdcLine.balance) : 0n;
  } catch {
    return {
      address,
      monitoringStatus: "error",
      usdcBalance: "—",
      xlmBalance: "—",
      availableXlmBalance: "—",
      baseReserveXlm: "—",
      minimumBalanceXlm: "—",
      nativeSellingLiabilitiesXlm: "—",
      numSubentries: null,
      numSponsoring: null,
      numSponsored: null,
      sponsoredReserveXlm: "—",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["Horizon wallet monitoring unavailable"],
      pages: [],
      assetStatus: { usdc: "unknown", xlm: "unknown" },
      thresholds,
    };
  }

  const { minimumBalanceStroops, spendableStroops } = calculateSpendableXlm({
    totalStroops,
    sellingLiabilitiesStroops,
    baseReserveStroops,
    subentryCount: numSubentries,
    numSponsoring,
    numSponsored,
  });
  // Preserved until callers consume minimumBalanceXlm directly. Unlike the old
  // constant estimate, this is derived from the same live reserve used above.
  const sponsoredReserveStroops = baseReserveStroops * BigInt(numSponsoring);
  const { healthy, warnings, pages, assetStatus } = evaluateStroopThresholds({
    xlmStroops: spendableStroops,
    usdcStroops,
    thresholds: thresholdStroops,
  });

  return {
    address,
    monitoringStatus: "healthy",
    usdcBalance: stroopsToDisplay(usdcStroops),
    xlmBalance: stroopsToDisplay(totalStroops),
    availableXlmBalance: stroopsToDisplay(spendableStroops),
    baseReserveXlm: stroopsToDisplay(baseReserveStroops),
    minimumBalanceXlm: stroopsToDisplay(minimumBalanceStroops),
    nativeSellingLiabilitiesXlm: stroopsToDisplay(sellingLiabilitiesStroops),
    numSubentries,
    numSponsoring,
    numSponsored,
    sponsoredReserveXlm: stroopsToDisplay(sponsoredReserveStroops),
    rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
    healthy,
    warnings,
    pages,
    assetStatus,
    thresholds,
  };
}

export async function checkAndAlert(): Promise<void> {
  const health = await getWalletHealth();
  for (const alert of walletBalanceAlerts(health)) {
    await sendDedupedDiscordAlert(alert);
  }
}
