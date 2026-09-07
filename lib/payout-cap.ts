import prisma from "./prisma";
import {
  sendDedupedDiscordAlert,
  type HealthAlertDelivery,
} from "./health-alert";

const DEFAULT_DAILY_CAP_UNITS = 2_000_000_000n; // 200 USDC (200 * 10^7 units)

export class PayoutCapError extends Error {
  readonly code = "daily_cap_reached";
  readonly currentUnits: bigint;
  readonly capUnits: bigint;

  constructor(currentUnits: bigint, capUnits: bigint) {
    super(`Daily payout cap reached: ${currentUnits} / ${capUnits} units`);
    this.name = "PayoutCapError";
    this.currentUnits = currentUnits;
    this.capUnits = capUnits;
  }
}

export function getDailyPayoutCapUnits(): bigint {
  const raw = process.env.DAILY_PAYOUT_CAP_UNITS;
  if (!raw) return DEFAULT_DAILY_CAP_UNITS;
  const value = BigInt(raw.trim());
  if (value < 0n) {
    console.warn("[payout-cap] DAILY_PAYOUT_CAP_UNITS is negative, falling back to default");
    return DEFAULT_DAILY_CAP_UNITS;
  }
  return value;
}

export interface PayoutActivity {
  count: number;
  volumeUnits: bigint;
}

export async function getPayoutActivitySince(since: Date): Promise<PayoutActivity> {
  const result = await prisma.payoutJob.aggregate({
    _count: { _all: true },
    _sum: { amountUnits: true },
    where: {
      status: { in: ["processing", "done"] },
      broadcastAt: { gte: since },
      txHash: { not: null },
      amountUnits: { not: null },
    },
  });
  return {
    count: result._count._all,
    volumeUnits: result._sum.amountUnits ?? 0n,
  };
}

export async function getRolling24hPayoutSum(): Promise<bigint> {
  const activity = await getPayoutActivitySince(new Date(Date.now() - 86_400_000));
  return activity.volumeUnits;
}

export async function checkPayoutCap(amount: bigint): Promise<{
  allowed: boolean;
  current: bigint;
  cap: bigint;
  remaining: bigint;
}> {
  const cap = getDailyPayoutCapUnits();

  if (cap === 0n) {
    return { allowed: true, current: 0n, cap: 0n, remaining: 0n };
  }

  const current = await getRolling24hPayoutSum();
  const remaining = cap - current;
  const allowed = remaining >= amount;

  if (!allowed) {
    console.warn(
      `[payout-cap] daily cap reached — current: ${current} units, cap: ${cap} units, attempt: ${amount} units`,
    );
    throw new PayoutCapError(current, cap);
  }

  return { allowed: true, current, cap, remaining };
}

export async function maybeSendCapAlert(): Promise<HealthAlertDelivery | "not-triggered"> {
  const cap = getDailyPayoutCapUnits();
  if (cap === 0n) return "not-triggered";

  const current = await getRolling24hPayoutSum();
  const pct = Number((current * 10000n) / cap) / 100; // two-decimal precision
  const configuredThreshold = Number(process.env.HEALTH_CAP_PERCENT_THRESHOLD ?? "80");
  const threshold =
    Number.isFinite(configuredThreshold) && configuredThreshold > 0 && configuredThreshold <= 100
      ? configuredThreshold
      : 80;
  if (pct < threshold) return "not-triggered";

  return sendDedupedDiscordAlert({
    key: "payout-cap",
    severity: pct >= 100 ? "PAGE" : "WARN",
    title: "Daily payout cap is approaching",
    lines: [
      `${pct}% consumed`,
      `${current} of ${cap} units spent`,
      `${cap > current ? cap - current : 0n} units remain`,
    ],
  });
}
