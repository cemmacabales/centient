import prisma from "./prisma";
import { redis } from "./redis";
import { REWARD_TOKEN_DECIMALS } from "./constants";

const DEFAULT_DAILY_CAP_WEI = 200_000000000000000000n; // ~$200 in 18-decimal cUSD
const DISCORD_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DISCORD_ALERT_REDIS_KEY = "t2p:cap_alert:last_sent";

export class PayoutCapError extends Error {
  readonly code = "daily_cap_reached";
  readonly currentWei: bigint;
  readonly capWei: bigint;

  constructor(currentWei: bigint, capWei: bigint) {
    super(`Daily payout cap reached: ${currentWei} / ${capWei} wei`);
    this.name = "PayoutCapError";
    this.currentWei = currentWei;
    this.capWei = capWei;
  }
}

export function getDailyPayoutCapWei(): bigint {
  const raw = process.env.DAILY_PAYOUT_CAP_WEI;
  if (!raw) return DEFAULT_DAILY_CAP_WEI;
  const value = BigInt(raw.trim());
  if (value < 0n) {
    console.warn("[payout-cap] DAILY_PAYOUT_CAP_WEI is negative, falling back to default");
    return DEFAULT_DAILY_CAP_WEI;
  }
  return value;
}

export async function getRolling24hPayoutSum(): Promise<bigint> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const aggregate = await prisma.submission.aggregate({
    _sum: { payoutAmountWei: true },
    where: {
      payoutStatus: { in: ["sent", "confirmed"] },
      createdAt: { gte: since },
    },
  });
  return aggregate._sum.payoutAmountWei ?? 0n;
}

export async function checkPayoutCap(amount: bigint): Promise<{
  allowed: boolean;
  current: bigint;
  cap: bigint;
  remaining: bigint;
}> {
  const cap = getDailyPayoutCapWei();

  if (cap === 0n) {
    return { allowed: true, current: 0n, cap: 0n, remaining: 0n };
  }

  const current = await getRolling24hPayoutSum();
  const remaining = cap - current;
  const allowed = remaining >= amount;

  if (!allowed) {
    console.warn(
      `[payout-cap] daily cap reached — current: ${current} wei, cap: ${cap} wei, attempt: ${amount} wei`,
    );
    throw new PayoutCapError(current, cap);
  }

  return { allowed: true, current, cap, remaining };
}

export async function maybeSendCapAlert(): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const cap = getDailyPayoutCapWei();
  if (cap === 0n) return;

  const current = await getRolling24hPayoutSum();
  const pct = Number((current * 10000n) / cap) / 100; // two-decimal precision
  if (pct < 80) return;

  try {
    const lastSent = await redis.get(DISCORD_ALERT_REDIS_KEY);
    if (lastSent) {
      const elapsed = Date.now() - parseInt(lastSent, 10);
      if (elapsed < DISCORD_ALERT_COOLDOWN_MS) return;
    }

    const message = [
      `Daily payout cap alert — **${pct}%** consumed`,
      `Current 24h spend: **${current}** wei`,
      `Cap: **${cap}** wei`,
      `Remaining: **${cap - current}** wei`,
      `Token decimals: ${REWARD_TOKEN_DECIMALS}`,
    ].join("\n");

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });

    if (!res.ok) {
      console.error(`[payout-cap] Discord webhook returned ${res.status}`);
      return;
    }

    await redis.set(DISCORD_ALERT_REDIS_KEY, String(Date.now()), "PX", DISCORD_ALERT_COOLDOWN_MS);
  } catch (err) {
    console.error("[payout-cap] Discord alert failed", err);
  }
}
