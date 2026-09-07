import prisma from "./prisma";
import { getDailyPayoutCapUnits, getRolling24hPayoutSum } from "./payout-cap";
import { redis } from "./redis";
import { getWalletHealth, type BalanceStatus, type WalletHealth } from "./stellar/balance";
import {
  sendDedupedDiscordAlert,
  type HealthAlert,
  type HealthAlertDelivery,
} from "./health-alert";
import { loadReserveRefillStatus, type ReserveRefillPlan } from "./stellar/reserve-refill";
import { walletBalanceAlerts } from "./wallet-balance-alerts";

const REFILL_DUE_REDIS_KEY = "t2p:reserve-refill:due-since";

const DEFAULT_THRESHOLDS = {
  payoutWindowMinutes: 60,
  payoutCountThreshold: 100,
  payoutVolumeUnitsThreshold: 1_000_000_000n,
  failureWindowMinutes: 15,
  failureCountThreshold: 3,
  capPercentThreshold: 80,
  refillOverdueMinutes: 30,
} satisfies HealthMonitorThresholds;

export interface HealthMonitorThresholds {
  payoutWindowMinutes: number;
  payoutCountThreshold: number;
  payoutVolumeUnitsThreshold: bigint;
  failureWindowMinutes: number;
  failureCountThreshold: number;
  capPercentThreshold: number;
  refillOverdueMinutes: number;
}

export interface HealthMonitorInput {
  wallet: {
    address: string;
    usdcBalance: string;
    availableXlmBalance: string;
    sponsoredReserveXlm: string;
    assetStatus: { usdc: BalanceStatus; xlm: BalanceStatus };
  };
  payoutCount: number;
  payoutVolumeUnits: bigint;
  failedPayoutCount: number;
  dailyCapUnits: bigint;
  dailySpentUnits: bigint;
  reserveStatus: "healthy" | "refill_required" | "insufficient_reserve" | "unconfigured";
  refillDueSinceMs: number | null;
  nowMs: number;
}

export interface HealthMonitorMetrics {
  payoutCount: number;
  payoutVolumeUnits: string;
  failedPayoutCount: number;
  dailyCapUnits: string;
  dailySpentUnits: string;
  dailyCapPercent: number;
  reserveStatus: HealthMonitorInput["reserveStatus"];
  hotBalanceUnits: string | null;
  coldBalanceUnits: string | null;
  refillDueSince: string | null;
}

export interface HealthMonitorSnapshot {
  checkedAt: string;
  wallet: WalletHealth;
  metrics: HealthMonitorMetrics;
  thresholds: Omit<HealthMonitorThresholds, "payoutVolumeUnitsThreshold"> & {
    payoutVolumeUnitsThreshold: string;
  };
  alerts: HealthAlert[];
}

type MonitorEnvironment = Readonly<Record<string, string | undefined>>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveUnits(value: string | undefined, fallback: bigint): bigint {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : fallback;
}

export function parseHealthMonitorThresholds(
  env: MonitorEnvironment = process.env,
): HealthMonitorThresholds {
  const capPercent = positiveInteger(
    env.HEALTH_CAP_PERCENT_THRESHOLD,
    DEFAULT_THRESHOLDS.capPercentThreshold,
  );
  return {
    payoutWindowMinutes: positiveInteger(
      env.HEALTH_PAYOUT_WINDOW_MINUTES,
      DEFAULT_THRESHOLDS.payoutWindowMinutes,
    ),
    payoutCountThreshold: positiveInteger(
      env.HEALTH_PAYOUT_COUNT_THRESHOLD,
      DEFAULT_THRESHOLDS.payoutCountThreshold,
    ),
    payoutVolumeUnitsThreshold: positiveUnits(
      env.HEALTH_PAYOUT_VOLUME_UNITS_THRESHOLD,
      DEFAULT_THRESHOLDS.payoutVolumeUnitsThreshold,
    ),
    failureWindowMinutes: positiveInteger(
      env.HEALTH_FAILURE_WINDOW_MINUTES,
      DEFAULT_THRESHOLDS.failureWindowMinutes,
    ),
    failureCountThreshold: positiveInteger(
      env.HEALTH_FAILURE_COUNT_THRESHOLD,
      DEFAULT_THRESHOLDS.failureCountThreshold,
    ),
    capPercentThreshold: capPercent <= 100 ? capPercent : DEFAULT_THRESHOLDS.capPercentThreshold,
    refillOverdueMinutes: positiveInteger(
      env.HEALTH_REFILL_OVERDUE_MINUTES,
      DEFAULT_THRESHOLDS.refillOverdueMinutes,
    ),
  };
}

export function evaluateHealthAlerts(
  input: HealthMonitorInput,
  thresholds: HealthMonitorThresholds = parseHealthMonitorThresholds(),
): HealthAlert[] {
  const alerts = walletBalanceAlerts(input.wallet);

  if (input.payoutCount >= thresholds.payoutCountThreshold) {
    alerts.push({
      key: "payout-rate-spike",
      severity: "WARN",
      title: "Payout rate is unusually high",
      lines: [
        `${input.payoutCount} payouts in ${thresholds.payoutWindowMinutes} minutes`,
        `Alert threshold: ${thresholds.payoutCountThreshold}`,
      ],
    });
  }

  if (input.payoutVolumeUnits >= thresholds.payoutVolumeUnitsThreshold) {
    alerts.push({
      key: "payout-volume-spike",
      severity: "WARN",
      title: "Payout volume is unusually high",
      lines: [
        `${input.payoutVolumeUnits} units paid in ${thresholds.payoutWindowMinutes} minutes`,
        `Alert threshold: ${thresholds.payoutVolumeUnitsThreshold} units`,
      ],
    });
  }

  if (input.dailyCapUnits > 0n) {
    const capPercent = Number((input.dailySpentUnits * 10_000n) / input.dailyCapUnits) / 100;
    if (capPercent >= thresholds.capPercentThreshold) {
      alerts.push({
        key: "payout-cap",
        severity: capPercent >= 100 ? "PAGE" : "WARN",
        title: "Daily payout cap is approaching",
        lines: [
          `${capPercent}% consumed`,
          `${input.dailySpentUnits} of ${input.dailyCapUnits} units spent`,
        ],
      });
    }
  }

  if (input.failedPayoutCount >= thresholds.failureCountThreshold) {
    alerts.push({
      key: "repeated-payout-failures",
      severity: "PAGE",
      title: "Payouts are repeatedly failing",
      lines: [
        `${input.failedPayoutCount} permanent failures in ${thresholds.failureWindowMinutes} minutes`,
        `Alert threshold: ${thresholds.failureCountThreshold}`,
      ],
    });
  }

  if (
    input.reserveStatus !== "healthy" &&
    input.reserveStatus !== "unconfigured" &&
    input.refillDueSinceMs !== null &&
    input.nowMs - input.refillDueSinceMs >= thresholds.refillOverdueMinutes * 60 * 1000
  ) {
    alerts.push({
      key: "reserve-refill-overdue",
      severity: "PAGE",
      title: "Hot-wallet refill is overdue",
      lines: [
        `Reserve status: ${input.reserveStatus}`,
        `Refill has remained due for at least ${thresholds.refillOverdueMinutes} minutes`,
      ],
    });
  }

  return alerts;
}

function reserveBalanceUnits(plan: ReserveRefillPlan): {
  hotBalanceUnits: bigint;
  coldBalanceUnits: bigint;
} {
  return {
    hotBalanceUnits: plan.hotBalanceUnits,
    coldBalanceUnits: plan.coldBalanceUnits,
  };
}

async function loadReserveStatus(): Promise<{
  plan: ReserveRefillPlan | null;
  status: HealthMonitorInput["reserveStatus"];
}> {
  try {
    const plan = await loadReserveRefillStatus();
    return { plan, status: plan.status };
  } catch (error) {
    console.warn(
      "[health-monitor] reserve monitoring unavailable",
      error instanceof Error ? error.name : typeof error,
    );
    return { plan: null, status: "unconfigured" };
  }
}

async function updateRefillDueSince(
  status: HealthMonitorInput["reserveStatus"],
  nowMs: number,
): Promise<number | null> {
  try {
    if (status === "healthy") {
      await redis.del(REFILL_DUE_REDIS_KEY);
      return null;
    }
    if (status === "unconfigured") return null;

    const created = await redis.set(REFILL_DUE_REDIS_KEY, String(nowMs), "NX");
    const stored = await redis.get(REFILL_DUE_REDIS_KEY);
    if (stored && /^\d+$/.test(stored)) return Number(stored);
    return created === "OK" ? nowMs : null;
  } catch (error) {
    console.error("[health-monitor] refill timer unavailable", error);
    return null;
  }
}

export async function getHealthMonitorSnapshot({
  nowMs = Date.now(),
  thresholds = parseHealthMonitorThresholds(),
}: {
  nowMs?: number;
  thresholds?: HealthMonitorThresholds;
} = {}): Promise<HealthMonitorSnapshot> {
  const payoutSince = new Date(nowMs - thresholds.payoutWindowMinutes * 60 * 1000);
  const failureSince = new Date(nowMs - thresholds.failureWindowMinutes * 60 * 1000);
  const dailyCapUnits = getDailyPayoutCapUnits();

  const [
    wallet,
    payoutCount,
    payoutVolume,
    failedPayoutCount,
    dailySpentUnits,
    reserve,
  ] = await Promise.all([
    getWalletHealth(),
    prisma.submission.count({
      where: {
        payoutStatus: { in: ["sent", "confirmed"] },
        createdAt: { gte: payoutSince },
      },
    }),
    prisma.submission.aggregate({
      _sum: { payoutAmountUnits: true },
      where: {
        payoutStatus: { in: ["sent", "confirmed"] },
        createdAt: { gte: payoutSince },
      },
    }),
    prisma.payoutJob.count({
      where: { status: "failed", completedAt: { gte: failureSince } },
    }),
    getRolling24hPayoutSum(),
    loadReserveStatus(),
  ]);

  const payoutVolumeUnits = payoutVolume._sum.payoutAmountUnits ?? 0n;
  const refillDueSinceMs = await updateRefillDueSince(reserve.status, nowMs);
  const input: HealthMonitorInput = {
    wallet,
    payoutCount,
    payoutVolumeUnits,
    failedPayoutCount,
    dailyCapUnits,
    dailySpentUnits,
    reserveStatus: reserve.status,
    refillDueSinceMs,
    nowMs,
  };
  const reserveBalances = reserve.plan ? reserveBalanceUnits(reserve.plan) : null;
  const dailyCapPercent =
    dailyCapUnits > 0n ? Number((dailySpentUnits * 10_000n) / dailyCapUnits) / 100 : 0;

  return {
    checkedAt: new Date(nowMs).toISOString(),
    wallet,
    metrics: {
      payoutCount,
      payoutVolumeUnits: payoutVolumeUnits.toString(),
      failedPayoutCount,
      dailyCapUnits: dailyCapUnits.toString(),
      dailySpentUnits: dailySpentUnits.toString(),
      dailyCapPercent,
      reserveStatus: reserve.status,
      hotBalanceUnits: reserveBalances?.hotBalanceUnits.toString() ?? null,
      coldBalanceUnits: reserveBalances?.coldBalanceUnits.toString() ?? null,
      refillDueSince:
        refillDueSinceMs === null ? null : new Date(refillDueSinceMs).toISOString(),
    },
    thresholds: {
      ...thresholds,
      payoutVolumeUnitsThreshold: thresholds.payoutVolumeUnitsThreshold.toString(),
    },
    alerts: evaluateHealthAlerts(input, thresholds),
  };
}

export async function runHealthMonitor(
  options: Parameters<typeof getHealthMonitorSnapshot>[0] = {},
): Promise<HealthMonitorSnapshot & {
  deliveries: Array<{ key: string; status: HealthAlertDelivery }>;
}> {
  const snapshot = await getHealthMonitorSnapshot(options);
  const deliveries = [];
  for (const alert of snapshot.alerts) {
    deliveries.push({ key: alert.key, status: await sendDedupedDiscordAlert(alert) });
  }
  return { ...snapshot, deliveries };
}
