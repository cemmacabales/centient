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
import { server } from "./config";

const MAX_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

/** XLM reserve locked on the sponsor per sponsored trustline (Stellar base reserve × 1). */
export const TRUSTLINE_RESERVE_XLM = 0.5;

/** Balance line as returned by Horizon `account.balances[]` (subset we read). */
interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
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
  /** USDC payout float. */
  usdcBalance: string;
  /** XLM held for fees + base/trustline reserves. */
  xlmBalance: string;
  /** Count of trustlines the platform is sponsoring (Horizon num_sponsoring). */
  numSponsoring: number;
  /** XLM locked by those sponsorships (0.5 × numSponsoring), informational. */
  sponsoredReserveXlm: string;
  rewardTokenSymbol: string;
  healthy: boolean;
  warnings: string[];
  pages: string[];
  thresholds: BalanceThresholds;
}

export function parseBalanceThresholds(): BalanceThresholds {
  return {
    warnUsdc: Number(process.env.BALANCE_WARN_USDC ?? "50"),
    pageUsdc: Number(process.env.BALANCE_PAGE_USDC ?? "10"),
    // XLM floor covers fees + the account's base reserve + every trustline
    // reserve. Sponsored recipient trustlines are subtracted from the balance in
    // getWalletHealth (ST-4e #314), so this threshold stays fee-oriented.
    warnXlm: Number(process.env.BALANCE_WARN_XLM ?? "5"),
    pageXlm: Number(process.env.BALANCE_PAGE_XLM ?? "2"),
  };
}

/**
 * Pull the two balances that matter out of a Horizon `balances[]` array: the
 * native XLM line and our USDC line (matched by `asset_code === 'USDC'` AND
 * `asset_issuer === STELLAR_USDC_ISSUER`). A missing USDC line means no trustline
 * / no float — reported as 0, which is correctly treated as low float downstream.
 */
export function extractBalances(balances: HorizonBalanceLine[]): { xlm: number; usdc: number } {
  const issuer = process.env.STELLAR_USDC_ISSUER?.trim();

  const native = balances.find((b) => b.asset_type === "native");
  const usdcLine = balances.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_code === "USDC" &&
      (issuer ? b.asset_issuer === issuer : true),
  );

  return {
    xlm: native ? Number(native.balance) : 0,
    usdc: usdcLine ? Number(usdcLine.balance) : 0,
  };
}

export function evaluateThresholds(
  xlmBalance: number,
  usdcBalance: number,
  thresholds: BalanceThresholds,
): { healthy: boolean; warnings: string[]; pages: string[] } {
  const warnings: string[] = [];
  const pages: string[] = [];

  if (usdcBalance <= thresholds.pageUsdc) {
    pages.push(
      `USDC float ${usdcBalance.toFixed(2)} USDC is below page threshold ${thresholds.pageUsdc} USDC`,
    );
  } else if (usdcBalance <= thresholds.warnUsdc) {
    warnings.push(
      `USDC float ${usdcBalance.toFixed(2)} USDC is below warning threshold ${thresholds.warnUsdc} USDC`,
    );
  }

  if (xlmBalance <= thresholds.pageXlm) {
    pages.push(
      `XLM fee/reserve balance ${xlmBalance.toFixed(4)} XLM is below page threshold ${thresholds.pageXlm} XLM`,
    );
  } else if (xlmBalance <= thresholds.warnXlm) {
    warnings.push(
      `XLM fee/reserve balance ${xlmBalance.toFixed(4)} XLM is below warning threshold ${thresholds.warnXlm} XLM`,
    );
  }

  return { healthy: warnings.length === 0 && pages.length === 0, warnings, pages };
}

interface CachedAlert {
  lastFiredAt: number;
}

const alertCooldowns: Record<string, CachedAlert> = {};

export function shouldFireAlert(key: string): boolean {
  const cached = alertCooldowns[key];
  if (!cached) return true;
  return Date.now() - cached.lastFiredAt > MAX_ALERT_COOLDOWN_MS;
}

export function recordAlertFired(key: string): void {
  alertCooldowns[key] = { lastFiredAt: Date.now() };
}

export async function getWalletHealth(): Promise<WalletHealth> {
  const thresholds = parseBalanceThresholds();
  const address = platformPublicKey();

  if (!address) {
    return {
      address: "—",
      usdcBalance: "—",
      xlmBalance: "—",
      numSponsoring: 0,
      sponsoredReserveXlm: "0.0000",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["STELLAR_PLATFORM_SECRET not configured"],
      pages: [],
      thresholds,
    };
  }

  let xlm = 0;
  let usdc = 0;
  let numSponsoring = 0;
  try {
    const account = await server().loadAccount(address);
    ({ xlm, usdc } = extractBalances(account.balances as HorizonBalanceLine[]));
    numSponsoring = Number((account as { num_sponsoring?: number }).num_sponsoring ?? 0);
  } catch {
    return {
      address,
      usdcBalance: "—",
      xlmBalance: "—",
      numSponsoring: 0,
      sponsoredReserveXlm: "0.0000",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      healthy: false,
      warnings: ["STELLAR_PLATFORM_SECRET not configured or Horizon unavailable"],
      pages: [],
      thresholds,
    };
  }

  // Sponsored reserves are locked on the platform account — subtract them so the
  // XLM floor reflects *available* fee XLM, not reserves the platform can't spend
  // (ST-4e #314). USDC float is unaffected.
  const sponsoredReserveXlm = TRUSTLINE_RESERVE_XLM * numSponsoring;
  const availableXlm = xlm - sponsoredReserveXlm;

  const { healthy, warnings, pages } = evaluateThresholds(availableXlm, usdc, thresholds);

  return {
    address,
    usdcBalance: usdc.toFixed(4),
    xlmBalance: xlm.toFixed(4),
    numSponsoring,
    sponsoredReserveXlm: sponsoredReserveXlm.toFixed(4),
    rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
    healthy,
    warnings,
    pages,
    thresholds,
  };
}

export async function sendDiscordAlert(
  health: WalletHealth,
  severity: "WARN" | "PAGE",
): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const color = severity === "PAGE" ? 0xe84118 : 0xf57c00;
  const title = `⚠️ [${severity}] Platform wallet ${health.address.slice(0, 10)}…`;

  const fields = [...health.warnings, ...health.pages].map((w) => ({
    name: w,
    value: "​",
    inline: false,
  }));

  const payload = {
    embeds: [
      {
        title,
        color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`[stellar/balance] Discord webhook failed: ${res.status}`);
  }
}

export async function checkAndAlert(): Promise<void> {
  const health = await getWalletHealth();
  if (!health.healthy) {
    const severity = health.pages.length > 0 ? "PAGE" : "WARN";
    const key = `${health.address}:${severity}`;
    if (shouldFireAlert(key)) {
      await sendDiscordAlert(health, severity);
      recordAlertFired(key);
    }
  }
}
