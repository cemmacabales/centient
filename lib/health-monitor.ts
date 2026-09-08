import prisma from "./prisma";
import {
  getDailyPayoutCapUnits,
  getPayoutActivitySince,
  getRolling24hPayoutSum,
} from "./payout-cap";
import { redis } from "./redis";
import { getWalletHealth, type BalanceStatus, type WalletHealth } from "./stellar/balance";
import {
  sendDedupedDiscordAlert,
  type HealthAlert,
  type HealthAlertDelivery,
} from "./health-alert";
import {
  loadReserveRefillStatus,
  parseReserveRefillPolicy,
  type ReserveRefillPlan,
} from "./stellar/reserve-refill";
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

export type MonitoringStatus = "healthy" | "unconfigured" | "error";

type ReserveStatus = ReserveRefillPlan["status"] | "unconfigured" | null;

type NullablePayoutMetrics = {
  payoutCount: number | null;
  payoutVolumeUnits: bigint | null;
  failedPayoutCount: number | null;
  dailySpentUnits: bigint | null;
  status: MonitoringStatus;
};

type SourceStatus = {
  wallet: MonitoringStatus;
  payouts: MonitoringStatus;
  reserve: MonitoringStatus;
  refillTimer: MonitoringStatus;
};

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
    monitoringStatus: MonitoringStatus;
    usdcBalance: string;
    availableXlmBalance: string;
    sponsoredReserveXlm: string;
    assetStatus: { usdc: BalanceStatus; xlm: BalanceStatus };
  };
  payoutCount: number | null;
  payoutVolumeUnits: bigint | null;
  failedPayoutCount: number | null;
  dailyCapUnits: bigint | null;
  dailySpentUnits: bigint | null;
  reserveStatus: ReserveStatus;
  refillDueSinceMs: number | null;
  payoutStatus: MonitoringStatus;
  reserveMonitoringStatus: MonitoringStatus;
  refillTimerStatus: MonitoringStatus;
  nowMs: number;
}

export interface HealthMonitorMetrics {
  payoutCount: number | null;
  payoutVolumeUnits: string | null;
  failedPayoutCount: number | null;
  dailyCapUnits: string | null;
  dailySpentUnits: string | null;
  dailyCapPercent: number | null;
  reserveStatus: HealthMonitorInput["reserveStatus"];
  hotBalanceUnits: string | null;
  coldBalanceUnits: string | null;
  refillDueSince: string | null;
  sourceStatus: SourceStatus;
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

  if (
    input.payoutCount !== null &&
    input.payoutCount >= thresholds.payoutCountThreshold
  ) {
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

  if (
    input.payoutVolumeUnits !== null &&
    input.payoutVolumeUnits >= thresholds.payoutVolumeUnitsThreshold
  ) {
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

  if (
    input.dailyCapUnits !== null &&
    input.dailySpentUnits !== null &&
    input.dailyCapUnits > 0n
  ) {
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

  if (
    input.failedPayoutCount !== null &&
    input.failedPayoutCount >= thresholds.failureCountThreshold
  ) {
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
    input.reserveStatus !== null &&
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

  if (input.payoutStatus === "error") {
    alerts.push({
      key: "payout-monitoring-unavailable",
      severity: "PAGE",
      title: "Payout monitoring is unavailable",
      lines: ["Rolling payout and failure metrics could not be loaded"],
    });
  }

  if (input.reserveMonitoringStatus === "unconfigured") {
    alerts.push({
      key: "reserve-monitoring-unconfigured",
      severity: "WARN",
      title: "Reserve monitoring is not configured",
      lines: ["Configure the cold reserve policy before relying on refill alerts"],
    });
  } else if (input.reserveMonitoringStatus === "error") {
    alerts.push({
      key: "reserve-monitoring-unavailable",
      severity: "PAGE",
      title: "Reserve monitoring is unavailable",
      lines: ["Hot and cold reserve balances could not be loaded"],
    });
  }

  if (input.refillTimerStatus === "error") {
    alerts.push({
      key: "refill-timer-unavailable",
      severity: "PAGE",
      title: "Reserve refill timing is unavailable",
      lines: ["The time since a reserve refill became due could not be loaded"],
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
  reserveStatus: ReserveStatus;
  status: MonitoringStatus;
}> {
  try {
    parseReserveRefillPolicy(process.env);
  } catch (error) {
    console.warn(
      "[health-monitor] reserve monitoring unconfigured",
      error instanceof Error ? error.name : typeof error,
    );
    return { plan: null, reserveStatus: "unconfigured", status: "unconfigured" };
  }

  try {
    const plan = await loadReserveRefillStatus({ env: process.env });
    return { plan, reserveStatus: plan.status, status: "healthy" };
  } catch (error) {
    console.error(
      "[health-monitor] reserve monitoring unavailable",
      error instanceof Error ? error.name : typeof error,
    );
    return { plan: null, reserveStatus: null, status: "error" };
  }
}

async function loadPayoutMetrics(
  payoutSince: Date,
  failureSince: Date,
): Promise<NullablePayoutMetrics> {
  try {
    const [activity, dailySpentUnits, failedPayoutCount] = await Promise.all([
      getPayoutActivitySince(payoutSince),
      getRolling24hPayoutSum(),
      prisma.payoutJob.count({
        where: { status: "failed", completedAt: { gte: failureSince } },
      }),
    ]);
    return {
      payoutCount: activity.count,
      payoutVolumeUnits: activity.volumeUnits,
      failedPayoutCount,
      dailySpentUnits,
      status: "healthy",
    };
  } catch (error) {
    console.error(
      "[health-monitor] payout monitoring unavailable",
      error instanceof Error ? error.name : typeof error,
    );
    return {
      payoutCount: null,
      payoutVolumeUnits: null,
      failedPayoutCount: null,
      dailySpentUnits: null,
      status: "error",
    };
  }
}

async function updateRefillDueSince(
  status: HealthMonitorInput["reserveStatus"],
  nowMs: number,
): Promise<{ dueSinceMs: number | null; status: MonitoringStatus }> {
  if (status === null || status === "unconfigured") {
    return { dueSinceMs: null, status: "unconfigured" };
  }

  try {
    if (status === "healthy") {
      await redis.del(REFILL_DUE_REDIS_KEY);
      return { dueSinceMs: null, status: "healthy" };
    }

    const created = await redis.set(REFILL_DUE_REDIS_KEY, String(nowMs), "NX");
    const stored = await redis.get(REFILL_DUE_REDIS_KEY);
    if (stored && /^\d+$/.test(stored)) {
      return { dueSinceMs: Number(stored), status: "healthy" };
    }
    return {
      dueSinceMs: created === "OK" ? nowMs : null,
      status: "healthy",
    };
  } catch (error) {
    console.error(
      "[health-monitor] refill timer unavailable",
      error instanceof Error ? error.name : typeof error,
    );
    return { dueSinceMs: null, status: "error" };
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
  const dailyCapUnits: bigint | null = getDailyPayoutCapUnits();

  const [wallet, payouts, reserve] = await Promise.all([
    getWalletHealth(),
    loadPayoutMetrics(payoutSince, failureSince),
    loadReserveStatus(),
  ]);

  const refillTimer = await updateRefillDueSince(reserve.reserveStatus, nowMs);
  const input: HealthMonitorInput = {
    wallet,
    payoutCount: payouts.payoutCount,
    payoutVolumeUnits: payouts.payoutVolumeUnits,
    failedPayoutCount: payouts.failedPayoutCount,
    dailyCapUnits,
    dailySpentUnits: payouts.dailySpentUnits,
    reserveStatus: reserve.reserveStatus,
    refillDueSinceMs: refillTimer.dueSinceMs,
    payoutStatus: payouts.status,
    reserveMonitoringStatus: reserve.status,
    refillTimerStatus: refillTimer.status,
    nowMs,
  };
  const reserveBalances = reserve.plan ? reserveBalanceUnits(reserve.plan) : null;
  const dailyCapPercent =
    dailyCapUnits !== null && payouts.dailySpentUnits !== null
      ? dailyCapUnits > 0n
        ? Number((payouts.dailySpentUnits * 10_000n) / dailyCapUnits) / 100
        : 0
      : null;

  return {
    checkedAt: new Date(nowMs).toISOString(),
    wallet,
    metrics: {
      payoutCount: payouts.payoutCount,
      payoutVolumeUnits: payouts.payoutVolumeUnits?.toString() ?? null,
      failedPayoutCount: payouts.failedPayoutCount,
      dailyCapUnits: dailyCapUnits?.toString() ?? null,
      dailySpentUnits: payouts.dailySpentUnits?.toString() ?? null,
      dailyCapPercent,
      reserveStatus: reserve.reserveStatus,
      hotBalanceUnits: reserveBalances?.hotBalanceUnits.toString() ?? null,
      coldBalanceUnits: reserveBalances?.coldBalanceUnits.toString() ?? null,
      refillDueSince:
        refillTimer.dueSinceMs === null
          ? null
          : new Date(refillTimer.dueSinceMs).toISOString(),
      sourceStatus: {
        wallet: wallet.monitoringStatus,
        payouts: payouts.status,
        reserve: reserve.status,
        refillTimer: refillTimer.status,
      },
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
  let snapshot: HealthMonitorSnapshot;
  try {
    snapshot = await getHealthMonitorSnapshot(options);
  } catch (error) {
    await sendDedupedDiscordAlert({
      key: "health-monitor-unavailable",
      severity: "PAGE",
      title: "Wallet-health monitor failed",
      lines: ["The health snapshot could not be assembled"],
    });
    throw error;
  }
  const deliveries = [];
  for (const alert of snapshot.alerts) {
    deliveries.push({ key: alert.key, status: await sendDedupedDiscordAlert(alert) });
  }
  return { ...snapshot, deliveries };
}
