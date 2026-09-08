import prisma from "./prisma";
import {
  sendDedupedDiscordAlert,
  type HealthAlert,
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

/** Configured daily payout cap in units; a negative setting uses the default. */
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

/**
 * Payout count and volume broadcast since `since`.
 *
 * Counts every job carrying a hash, an amount, and a broadcast time, whatever
 * its status. A hash is written only after Horizon accepted the payment, so the
 * funds have left the wallet even when the job was later quarantined as
 * `failed` for manual reconciliation (#73). Excluding those would let the daily
 * cap under-count real spend. Withdrawals have no Submission row, so this is
 * the only complete source.
 */
export async function getPayoutActivitySince(since: Date): Promise<PayoutActivity> {
  const result = await prisma.payoutJob.aggregate({
    _count: { _all: true },
    _sum: { amountUnits: true },
    where: {
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

/** Units broadcast in the trailing 24 hours — the daily cap's spend side. */
export async function getRolling24hPayoutSum(): Promise<bigint> {
  const activity = await getPayoutActivitySince(new Date(Date.now() - 86_400_000));
  return activity.volumeUnits;
}

/**
 * Authorize one payout against the rolling daily cap, throwing `PayoutCapError`
 * when it would exceed it. A cap of zero disables the limit entirely.
 *
 * This is a check, not a reservation: concurrent payouts can each pass and
 * together exceed the cap. That is a deliberate trade-off against distributed
 * reservation, bounded by the cap alert.
 */
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

export const DEFAULT_CAP_PERCENT_THRESHOLD = 80;

/**
 * Percentage of the daily cap at which the `payout-cap` alert fires. Accepts any
 * finite percentage in (0, 100]; anything else falls back to the documented
 * default. Shared so the payout path and the health monitor cannot disagree on
 * when the same alert identity is due.
 */
export function parseCapPercentThreshold(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(env.HEALTH_CAP_PERCENT_THRESHOLD ?? DEFAULT_CAP_PERCENT_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : DEFAULT_CAP_PERCENT_THRESHOLD;
}

/** Consumed percentage of the cap, to two decimals, using exact bigint math. */
export function capPercentConsumed(spentUnits: bigint, capUnits: bigint): number {
  return Number((spentUnits * 10_000n) / capUnits) / 100;
}

/**
 * Build the `payout-cap` alert, or null when the cap is unset or still below the
 * threshold. Both the payout path (`maybeSendCapAlert`) and the health monitor
 * raise this identity, and they share one Redis deduplication lease — whichever
 * fires first is the message the operator sees, so both must build it here.
 */
export function buildPayoutCapAlert(
  spentUnits: bigint,
  capUnits: bigint,
  thresholdPercent: number = parseCapPercentThreshold(),
): HealthAlert | null {
  if (capUnits <= 0n) return null;
  const pct = capPercentConsumed(spentUnits, capUnits);
  if (pct < thresholdPercent) return null;

  const exhausted = pct >= 100;
  return {
    key: "payout-cap",
    severity: exhausted ? "PAGE" : "WARN",
    // Severity and title are derived from the same number: a paging alert that
    // says "approaching" understates an exhausted cap to whoever is on call.
    title: exhausted ? "Daily payout cap is exhausted" : "Daily payout cap is approaching",
    lines: [
      `${pct}% consumed`,
      `${spentUnits} of ${capUnits} units spent`,
      `${capUnits > spentUnits ? capUnits - spentUnits : 0n} units remain`,
    ],
  };
}

/**
 * Deliver the cap alert if recorded spend plus an optional payout that has not
 * reached the ledger yet has reached the threshold.
 */
export async function maybeSendCapAlert(
  pendingAmountUnits: bigint = 0n,
): Promise<HealthAlertDelivery | "not-triggered"> {
  const cap = getDailyPayoutCapUnits();
  if (cap === 0n) return "not-triggered";

  const recordedSpend = await getRolling24hPayoutSum();
  const alert = buildPayoutCapAlert(recordedSpend + pendingAmountUnits, cap);
  if (!alert) return "not-triggered";

  return sendDedupedDiscordAlert(alert);
}
