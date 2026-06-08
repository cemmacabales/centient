import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  REWARD_TOKEN_ADDRESS,
  REWARD_TOKEN_DECIMALS,
  REWARD_TOKEN_SYMBOL,
  activeChain,
  activeRpcUrl,
} from "./constants";

const MAX_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

const WALLET_ADDRESS: `0x${string}` | null = process.env.PAYOUT_PRIVATE_KEY
  ? (privateKeyToAccount(process.env.PAYOUT_PRIVATE_KEY as `0x${string}`).address ?? null)
  : null;

export interface BalanceThresholds {
  warnCelo: number;
  pageCelo: number;
  warnReward: number;
  pageReward: number;
}

export interface WalletHealth {
  address: string;
  rewardTokenBalance: string;
  rewardTokenSymbol: string;
  celoBalance: string;
  healthy: boolean;
  warnings: string[];
  pages: string[];
  thresholds: BalanceThresholds;
}

export function parseBalanceThresholds(): BalanceThresholds {
  return {
    warnCelo: Number(process.env.BALANCE_WARN_CELO ?? "0.5"),
    pageCelo: Number(process.env.BALANCE_PAGE_CELO ?? "0.1"),
    warnReward: Number(process.env.BALANCE_WARN_REWARD ?? "50"),
    pageReward: Number(process.env.BALANCE_PAGE_REWARD ?? "10"),
  };
}

export function evaluateThresholds(
  celoBalance: number,
  rewardBalance: number,
  thresholds: BalanceThresholds,
): { healthy: boolean; warnings: string[]; pages: string[] } {
  const warnings: string[] = [];
  const pages: string[] = [];

  if (celoBalance <= thresholds.pageCelo) {
    pages.push(
      `CELO balance ${celoBalance.toFixed(4)} CELO is below page threshold ${thresholds.pageCelo} CELO`,
    );
  } else if (celoBalance <= thresholds.warnCelo) {
    warnings.push(
      `CELO balance ${celoBalance.toFixed(4)} CELO is below warning threshold ${thresholds.warnCelo} CELO`,
    );
  }

  if (rewardBalance <= thresholds.pageReward) {
    pages.push(
      `${REWARD_TOKEN_SYMBOL} balance ${rewardBalance.toFixed(2)} is below page threshold ${thresholds.pageReward}`,
    );
  } else if (rewardBalance <= thresholds.warnReward) {
    warnings.push(
      `${REWARD_TOKEN_SYMBOL} balance ${rewardBalance.toFixed(2)} is below warning threshold ${thresholds.warnReward}`,
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

  if (!WALLET_ADDRESS) {
    return {
      address: "—",
      rewardTokenBalance: "—",
      rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
      celoBalance: "—",
      healthy: false,
      warnings: ["PAYOUT_PRIVATE_KEY not configured"],
      pages: [],
      thresholds,
    };
  }

  const client = createPublicClient({ chain: activeChain(), transport: http(activeRpcUrl()) });

  const [celoRaw, rewardRaw] = await Promise.all([
    client.getBalance({ address: WALLET_ADDRESS }),
    client.readContract({
      address: REWARD_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [WALLET_ADDRESS],
    }),
  ]);

  const celoBalance = Number(formatUnits(celoRaw, 18));
  const rewardBalance = Number(formatUnits(rewardRaw, REWARD_TOKEN_DECIMALS));

  const { healthy, warnings, pages } = evaluateThresholds(celoBalance, rewardBalance, thresholds);

  return {
    address: WALLET_ADDRESS,
    rewardTokenBalance: rewardBalance.toFixed(4),
    rewardTokenSymbol: REWARD_TOKEN_SYMBOL,
    celoBalance: celoBalance.toFixed(4),
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
  const title = `⚠️ [${severity}] Hot wallet ${health.address.slice(0, 10)}…`;

  const fields = [...health.warnings, ...health.pages].map((w) => ({
    name: w,
    value: "\u200b",
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
    console.error(`[celo-balance] Discord webhook failed: ${res.status}`);
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