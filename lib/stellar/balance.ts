// Dual-asset wallet-health for the pooled platform account (ST-3c #297).
// Replaces lib/celo-balance.ts. USDC is non-native, so the pooled account holds
// TWO balances that both matter:
//   - USDC — the payout float; if it runs low, withdrawals can't be funded.
//   - XLM  — pays every transaction's fee + the base/trustline reserves; if it
//            runs low, NO payout can be submitted even with USDC on hand.
// A USDC-only check would silently strand payouts on an XLM-starved account, so
// both assets get their own thresholds. The Discord alert + cooldown mechanism is
// preserved from celo-balance; alerts say which asset crossed its threshold.
import { StrKey } from "@stellar/stellar-sdk";
import { REWARD_TOKEN_SYMBOL } from "../constants";
import { sendDedupedDiscordAlert } from "../health-alert";
import { walletBalanceAlerts } from "../wallet-balance-alerts";
import { withDeadline } from "../deadline";
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

/**
 * Public key of the pooled platform account, or null when it is not identifiable.
 *
 * Reads `STELLAR_PLATFORM_ACCOUNT`, because reading balances is a public
 * operation and must not require custody of a signing seed. Deriving this
 * address from the payout master contributed to the single-deployment custody
 * defect (F-01).
 *
 * Never throws: this module is imported at load time by routes and workers, so a
 * bad value must degrade to "unconfigured", not crash them.
 */
function platformPublicKey(): string | null {
  const account = process.env.STELLAR_PLATFORM_ACCOUNT?.trim();
  if (!account) return null;
  if (StrKey.isValidEd25519PublicKey(account)) return account;
  console.warn(
    "[stellar/balance] STELLAR_PLATFORM_ACCOUNT is set but not a valid public key — treating wallet as unconfigured",
  );
  return null;
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

/** Render stroops as a fixed-point string. The bigint-to-display boundary. */
function stroopsToDisplay(stroops: bigint, decimalPlaces = 4): string {
  if (stroops < 0n) throw new Error("XLM stroops must be non-negative");
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole}.${fraction.slice(0, decimalPlaces)}`;
}

const DEFAULT_HORIZON_TIMEOUT_MS = 10_000;

/**
 * Deadline for the Horizon reads behind a wallet-health check. `@stellar/
 * stellar-sdk` defaults to `Config.timeout = 0` (wait forever), which would let
 * a stalled Horizon hang the cron route and the admin page instead of degrading
 * to `monitoringStatus: "error"`. Bound locally rather than through the SDK's
 * global `Config` so payout submission timeouts stay untouched.
 */
function horizonTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(env.STELLAR_HORIZON_TIMEOUT_MS ?? DEFAULT_HORIZON_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_HORIZON_TIMEOUT_MS;
}

/** Read a non-negative reserve count from Horizon, rejecting anything else. */
function countFromHorizon(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`Invalid Horizon ${name}`);
}

/** Read the live base reserve from the latest ledger, in stroops. */
function baseReserveStroopsFromLedger(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  throw new Error("Invalid Horizon base_reserve_in_stroops");
}

/**
 * XLM actually available to pay fees, in stroops.
 *
 * Stellar locks a base reserve per account entry: two for the account itself,
 * one per subentry, one per sponsorship the account extends, less the entries
 * another account sponsors on its behalf. Selling liabilities are committed to
 * open offers. Gross balance therefore overstates what a payout can spend.
 */
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

/** Every balance threshold, normalized once into exact stroops. */
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

export interface StroopThresholds {
  warnUsdcStroops: bigint;
  pageUsdcStroops: bigint;
  warnXlmStroops: bigint;
  pageXlmStroops: bigint;
}

/**
 * Compare both balances against their thresholds using exact stroop arithmetic,
 * and describe each breach. USDC and XLM are judged independently: a healthy
 * float on an XLM-starved account still cannot submit a payout.
 */
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

/**
 * Current dual-asset health of the pooled platform account.
 *
 * Never throws and never guesses: an unset account or asset yields
 * `monitoringStatus: "unconfigured"`, a Horizon failure or stall yields
 * `"error"`, and in both cases balances render as em dashes and reserve counts
 * as null rather than as a zero that would read like a live measurement.
 */
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
      warnings: ["STELLAR_PLATFORM_ACCOUNT not configured"],
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
  } catch (error) {
    // Class only: asset/config errors can quote the configured issuer and seed.
    console.error(
      "[stellar/balance] configured USDC asset unusable",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
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
    // Abandoned on timeout: the in-flight requests are left to settle on their
    // own, and this check degrades to an explicit monitoring error.
    const [account, ledgerPage] = await withDeadline(
      "Horizon wallet health",
      Promise.all([
        horizon.loadAccount(address),
        horizon.ledgers().order("desc").limit(1).call(),
      ]),
      horizonTimeoutMs(),
    );
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
  } catch (error) {
    // Distinguishes a Horizon outage, a stall (OperationTimeoutError), and
    // malformed account data — without logging a URL-bearing message.
    console.error(
      "[stellar/balance] Horizon wallet monitoring unavailable",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
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

/** Read wallet health and deliver whatever balance alerts it warrants. */
export async function checkAndAlert(): Promise<void> {
  const health = await getWalletHealth();
  for (const alert of walletBalanceAlerts(health)) {
    await sendDedupedDiscordAlert(alert);
  }
}
