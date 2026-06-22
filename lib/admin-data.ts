import * as Sentry from "@sentry/nextjs";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import prisma from "./prisma";
import { normalizeReason } from "./quality";
import {
  REWARD_TOKEN_ADDRESS,
  REWARD_TOKEN_DECIMALS,
  REWARD_TOKEN_SYMBOL,
  activeChain,
  activeRpcUrl,
} from "./constants";

export interface DashboardTotals {
  totalSubmissions: number;
  totalPaidSubmissions: number;
  totalFailedSubmissions: number;
  totalPaidOut: string;
  rewardSymbol: string;
  hotWalletBalance: string;
  hotWalletAddress: string;
  uniqueWallets: number;
  bannedWallets: number;
}

export interface TaskRow {
  id: string;
  prompt: string;
  category: string | null;
  isGold: boolean;
  goldAnswer: string | null;
  submissionCount: number;
  majorityAnswer: string | null;
  agreementScore: number | null;
}

export interface TaskDetail {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  category: string | null;
  isGold: boolean;
  goldAnswer: string | null;
  majorityAnswer: string | null;
  agreementScore: number | null;
  recentSubmissions: RecentSubmission[];
}

export interface RecentSubmission {
  id: string;
  walletAddress: string;
  choice: string;
  reason: string;
  payoutStatus: string;
  payoutTxHash: string | null;
  createdAt: Date;
}

export interface WalletRow {
  walletAddress: string;
  createdAt: Date;
  submissionCount: number;
  totalEarned: string;
  goldCorrect: number;
  goldAttempted: number;
  goldAccuracyPct: number | null;
  isBanned: boolean;
  banCount: number;
  bannedUntil: Date | null;
}

export interface DashboardActivity {
  id: string;
  walletAddress: string;
  taskId: string;
  choice: string;
  payoutStatus: string;
  createdAt: Date;
}

async function hotWallet(): Promise<{ address: string; balance: string }> {
  const key = process.env.PAYOUT_PRIVATE_KEY;
  if (!key) {
    return { address: "—", balance: "—" };
  }
  try {
    const account = privateKeyToAccount(key as `0x${string}`);
    const client = createPublicClient({ chain: activeChain(), transport: http(activeRpcUrl()) });
    const raw = await client.readContract({
      address: REWARD_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    return {
      address: account.address,
      balance: formatUnits(raw, REWARD_TOKEN_DECIMALS),
    };
  } catch (err) {
    const account = (() => {
      try {
        return privateKeyToAccount(key as `0x${string}`).address;
      } catch {
        return "—";
      }
    })();
    console.error("[admin] hot wallet balance lookup failed", err);
    Sentry.captureException(err, {
      extra: { context: "hot-wallet-balance" },
    });
    return { address: account, balance: "—" };
  }
}

export async function getDashboardTotals(): Promise<DashboardTotals> {
  const [
    totalSubmissions,
    totalPaidSubmissions,
    totalFailedSubmissions,
    paidAggregate,
    uniqueWallets,
    bannedWallets,
    wallet,
  ] = await Promise.all([
    prisma.submission.count(),
    prisma.submission.count({ where: { payoutStatus: "sent" } }),
    prisma.submission.count({ where: { payoutStatus: "failed" } }),
    prisma.submission.aggregate({
      _sum: { payoutAmountWei: true },
      where: { payoutStatus: "sent" },
    }),
    prisma.user.count(),
    prisma.user.count({ where: { isBanned: true } }),
    hotWallet(),
  ]);

  const paidWei = paidAggregate._sum.payoutAmountWei ?? 0n;

  return {
    totalSubmissions,
    totalPaidSubmissions,
    totalFailedSubmissions,
    totalPaidOut: formatUnits(paidWei, REWARD_TOKEN_DECIMALS),
    rewardSymbol: REWARD_TOKEN_SYMBOL,
    hotWalletBalance: wallet.balance,
    hotWalletAddress: wallet.address,
    uniqueWallets,
    bannedWallets,
  };
}

export async function getRecentActivity(limit = 10): Promise<DashboardActivity[]> {
  const rows = await prisma.submission.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      walletAddress: true,
      taskId: true,
      choice: true,
      payoutStatus: true,
      createdAt: true,
    },
  });
  return rows;
}

export async function getTaskRows(): Promise<TaskRow[]> {
  const tasks = await prisma.task.findMany({
    orderBy: [{ isGold: "asc" }, { id: "asc" }],
    include: { _count: { select: { submissions: true } } },
  });
  return tasks.map((t) => ({
    id: t.id,
    prompt: t.prompt.length > 160 ? `${t.prompt.slice(0, 157)}…` : t.prompt,
    category: t.category,
    isGold: t.isGold,
    goldAnswer: t.goldAnswer,
    submissionCount: t._count.submissions,
    majorityAnswer: t.majorityAnswer,
    agreementScore: t.agreementScore,
  }));
}

export interface TaskTableSubmission {
  id: string;
  walletAddress: string;
  choice: string;
  reason: string;
  payoutStatus: string;
  payoutTxHash: string | null;
  createdAt: string;
}

export interface TaskTableItem {
  id: string;
  prompt: string;
  promptPreview: string;
  responseA: string;
  responseB: string;
  category: string | null;
  isGold: boolean;
  goldAnswer: string | null;
  submissionCount: number;
  majorityAnswer: string | null;
  agreementScore: number | null;
  recentSubmissions: TaskTableSubmission[];
  disabled: boolean;
}

export async function getTaskTableItems(): Promise<TaskTableItem[]> {
  const tasks = await prisma.task.findMany({
    orderBy: [{ isGold: "asc" }, { id: "asc" }],
    include: {
      _count: { select: { submissions: true } },
      submissions: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          walletAddress: true,
          choice: true,
          reason: true,
          payoutStatus: true,
          payoutTxHash: true,
          createdAt: true,
        },
      },
    },
  });
  return tasks.map((t) => ({
    id: t.id,
    prompt: t.prompt,
    promptPreview: t.prompt.length > 160 ? `${t.prompt.slice(0, 157)}…` : t.prompt,
    responseA: t.responseA,
    responseB: t.responseB,
    category: t.category,
    isGold: t.isGold,
    goldAnswer: t.goldAnswer,
    submissionCount: t._count.submissions,
    majorityAnswer: t.majorityAnswer,
    agreementScore: t.agreementScore,
    recentSubmissions: t.submissions.map((s) => ({
      id: s.id,
      walletAddress: s.walletAddress,
      choice: s.choice,
      reason: s.reason,
      payoutStatus: s.payoutStatus,
      payoutTxHash: s.payoutTxHash,
      createdAt: s.createdAt.toISOString(),
    })),
    disabled: t.disabled,
  }));
}

export async function getTaskDetail(id: string): Promise<TaskDetail | null> {
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      submissions: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          walletAddress: true,
          choice: true,
          reason: true,
          payoutStatus: true,
          payoutTxHash: true,
          createdAt: true,
        },
      },
    },
  });
  if (!task) return null;
  return {
    id: task.id,
    prompt: task.prompt,
    responseA: task.responseA,
    responseB: task.responseB,
    category: task.category,
    isGold: task.isGold,
    goldAnswer: task.goldAnswer,
    majorityAnswer: task.majorityAnswer,
    agreementScore: task.agreementScore,
    recentSubmissions: task.submissions,
  };
}

export async function getWalletRows(): Promise<WalletRow[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
  });
  return users.map((u) => ({
    walletAddress: u.walletAddress ?? "", // legacy rows are always wallet-keyed; null only once wallet-less accounts land (later phase)
    createdAt: u.createdAt,
    submissionCount: u.submissionCount,
    totalEarned: formatUnits(u.totalEarnedWei, REWARD_TOKEN_DECIMALS),
    goldCorrect: u.goldCorrect,
    goldAttempted: u.goldAttempted,
    goldAccuracyPct:
      u.goldAttempted === 0 ? null : Math.round((u.goldCorrect / u.goldAttempted) * 100),
    isBanned: u.isBanned,
    banCount: u.banCount,
    bannedUntil: u.bannedUntil,
  }));
}

export interface UserRow {
  walletAddress: string;
  createdAt: Date;
  submissionCount: number;
  totalEarned: string;
  goldCorrect: number;
  goldAttempted: number;
  goldAccuracyPct: number | null;
  isBanned: boolean;
  bannedAt: Date | null;
  bannedReason: string | null;
  banCount: number;
  bannedUntil: Date | null;
  lastBanAt: Date | null;
  country: string | null;
  gender: string | null;
  ageRange: string | null;
  onboardingCompleted: boolean;
  lastSubmissionAt: Date | null;
}

export async function getUserRows(): Promise<UserRow[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
  });
  return users.map((u) => ({
    walletAddress: u.walletAddress ?? "", // legacy rows are always wallet-keyed; null only once wallet-less accounts land (later phase)
    createdAt: u.createdAt,
    submissionCount: u.submissionCount,
    totalEarned: formatUnits(u.totalEarnedWei, REWARD_TOKEN_DECIMALS),
    goldCorrect: u.goldCorrect,
    goldAttempted: u.goldAttempted,
    goldAccuracyPct:
      u.goldAttempted === 0 ? null : Math.round((u.goldCorrect / u.goldAttempted) * 100),
    isBanned: u.isBanned,
    bannedAt: u.bannedAt,
    bannedReason: u.bannedReason,
    banCount: u.banCount,
    bannedUntil: u.bannedUntil,
    lastBanAt: u.lastBanAt,
    country: u.country,
    gender: u.gender,
    ageRange: u.ageRange,
    onboardingCompleted: u.onboardingCompleted,
    lastSubmissionAt: u.lastSubmissionAt,
  }));
}

export interface UserProfile {
  walletAddress: string;
  createdAt: Date;
  totalEarned: string;
  totalEarnedWei: bigint;
  submissionCount: number;
  goldCorrect: number;
  goldAttempted: number;
  goldAccuracyPct: number | null;
  isBanned: boolean;
  bannedAt: Date | null;
  bannedReason: string | null;
  banCount: number;
  bannedUntil: Date | null;
  lastBanAt: Date | null;
  country: string | null;
  gender: string | null;
  ageRange: string | null;
  onboardingCompleted: boolean;
  payoutTotals: {
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
    abandoned: number;
  };
  recentSubmissions: Array<{
    id: string;
    taskId: string;
    taskPrompt: string;
    choice: string;
    reason: string;
    isGoldCheck: boolean;
    goldPassed: boolean | null;
    payoutAmountWei: bigint;
    payoutStatus: string;
    payoutTxHash: string | null;
    createdAt: Date;
  }>;
  reasonRepetition: {
    hasRepetition: boolean;
    maxDuplicateCount: number;
    mostCommonReason: string | null;
  };
}

export async function getUserProfile(walletAddress: string): Promise<UserProfile | null> {
  const wallet = walletAddress.toLowerCase();
  const u = await prisma.user.findUnique({
    where: { walletAddress: wallet },
  });
  if (!u) return null;

  const [payoutGrouped, recent] = await Promise.all([
    prisma.submission.groupBy({
      by: ["payoutStatus"],
      where: { walletAddress: wallet },
      _count: { _all: true },
    }),
    prisma.submission.findMany({
      where: { walletAddress: wallet },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { task: { select: { prompt: true } } },
    }),
  ]);

  const payoutTotals = payoutGrouped.reduce(
    (acc, row) => {
      const key = row.payoutStatus as keyof typeof acc;
      if (key in acc) acc[key] = row._count._all;
      return acc;
    },
    { pending: 0, sent: 0, failed: 0, skipped: 0, abandoned: 0 } as { pending: number; sent: number; failed: number; skipped: number; abandoned: number },
  );

  return {
    walletAddress: wallet,
    createdAt: u.createdAt,
    totalEarned: formatUnits(u.totalEarnedWei, REWARD_TOKEN_DECIMALS),
    totalEarnedWei: u.totalEarnedWei,
    submissionCount: u.submissionCount,
    goldCorrect: u.goldCorrect,
    goldAttempted: u.goldAttempted,
    goldAccuracyPct:
      u.goldAttempted === 0 ? null : Math.round((u.goldCorrect / u.goldAttempted) * 100),
    isBanned: u.isBanned,
    bannedAt: u.bannedAt,
    bannedReason: u.bannedReason,
    banCount: u.banCount,
    bannedUntil: u.bannedUntil,
    lastBanAt: u.lastBanAt,
    country: u.country,
    gender: u.gender,
    ageRange: u.ageRange,
    onboardingCompleted: u.onboardingCompleted,
    payoutTotals,
    recentSubmissions: recent.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      taskPrompt: s.task.prompt,
      choice: s.choice,
      reason: s.reason,
      isGoldCheck: s.isGoldCheck,
      goldPassed: s.goldPassed,
      payoutAmountWei: s.payoutAmountWei,
      payoutStatus: s.payoutStatus,
      payoutTxHash: s.payoutTxHash,
      createdAt: s.createdAt,
    })),
    reasonRepetition: computeRepetitionStats(recent.map((s) => s.reason)),
  };
}

export interface PoolHealth {
  pendingSubmissions: number;
  pendingOldestAt: Date | null;
  failedSubmissions: number;
  failedLast24h: number;
  abandonedSubmissions: number;
  totalTasks: number;
  totalCampaignTasks: number;
  totalPlatformGoldTasks: number;
  totalUsers: number;
  bannedUsers: number;
  hotWalletAddress: string;
  hotWalletBalance: string;
  rewardSymbol: string;
  stuckPayoutThresholdMs: number;
  dailyPayoutCapWei: string;
  dailyPayoutSpentWei: string;
  dailyPayoutRemainingWei: string;
  dailyPayoutSpentPct: number;
}

const STUCK_PAYOUT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function getHealthSnapshot(): Promise<PoolHealth> {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    pending,
    pendingOldest,
    failedAll,
    failedLast24h,
    abandonedAll,
    totalTasks,
    totalCampaignTasks,
    totalPlatformGoldTasks,
    totalUsers,
    bannedUsers,
    wallet,
    dailyPayoutAgg,
  ] = await Promise.all([
    prisma.submission.count({ where: { payoutStatus: "pending" } }),
    prisma.submission.findFirst({
      where: { payoutStatus: "pending" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.submission.count({ where: { payoutStatus: "failed" } }),
    prisma.submission.count({
      where: { payoutStatus: "failed", createdAt: { gte: last24h } },
    }),
    prisma.submission.count({ where: { payoutStatus: "abandoned" } }),
    prisma.task.count(),
    prisma.task.count({ where: { campaignId: { not: null } } }),
    prisma.task.count({ where: { isGold: true, campaignId: null } }),
    prisma.user.count(),
    prisma.user.count({ where: { isBanned: true } }),
    hotWallet(),
    prisma.submission.aggregate({
      _sum: { payoutAmountWei: true },
      where: {
        payoutStatus: { in: ["sent", "confirmed"] },
        createdAt: { gte: last24h },
      },
    }),
  ]);

  const dailyCapRaw = process.env.DAILY_PAYOUT_CAP_WEI;
  const dailyCapWei = dailyCapRaw ? BigInt(dailyCapRaw.trim()) : 200_000000000000000000n;
  const dailySpentWei = dailyPayoutAgg._sum.payoutAmountWei ?? 0n;
  const dailyRemainingWei = dailyCapWei > dailySpentWei ? dailyCapWei - dailySpentWei : 0n;
  const dailyPayoutSpentPct =
    dailyCapWei > 0n ? Math.round(Number((dailySpentWei * 10000n) / dailyCapWei)) / 100 : 0;

  return {
    pendingSubmissions: pending,
    pendingOldestAt: pendingOldest?.createdAt ?? null,
    failedSubmissions: failedAll,
    failedLast24h,
    abandonedSubmissions: abandonedAll,
    totalTasks,
    totalCampaignTasks,
    totalPlatformGoldTasks,
    totalUsers,
    bannedUsers,
    hotWalletAddress: wallet.address,
    hotWalletBalance: wallet.balance,
    rewardSymbol: REWARD_TOKEN_SYMBOL,
    stuckPayoutThresholdMs: STUCK_PAYOUT_THRESHOLD_MS,
    dailyPayoutCapWei: String(dailyCapWei),
    dailyPayoutSpentWei: String(dailySpentWei),
    dailyPayoutRemainingWei: String(dailyRemainingWei),
    dailyPayoutSpentPct,
  };
}

export function isStuckPending(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > STUCK_PAYOUT_THRESHOLD_MS;
}

function computeRepetitionStats(reasons: string[]): {
  hasRepetition: boolean;
  maxDuplicateCount: number;
  mostCommonReason: string | null;
} {
  if (reasons.length === 0) {
    return { hasRepetition: false, maxDuplicateCount: 0, mostCommonReason: null };
  }

  const normalized = reasons.map((r) => normalizeReason(r));
  const freq = new Map<string, number>();
  for (const r of normalized) {
    freq.set(r, (freq.get(r) ?? 0) + 1);
  }

  let maxCount = 0;
  let mostCommon: string | null = null;
  for (const [r, count] of freq) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = r;
    }
  }

  const window = parseInt(process.env.REASON_REPEAT_WINDOW ?? "10", 10);
  const max = parseInt(process.env.REASON_REPEAT_MAX ?? "3", 10);
  const hasRepetition = normalized.length >= window && maxCount >= max;

  return { hasRepetition, maxDuplicateCount: maxCount, mostCommonReason: mostCommon };
}

// ---------------------------------------------------------------------------
// Tiered-ban cooldown helpers (issue #200)
// ---------------------------------------------------------------------------

export const RETEST_GOLD_COUNT = 3;
export const RETEST_PASS_THRESHOLD = 0.6; // >= 60%
export const BAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CooldownBanResult {
  banCount: number;
  bannedUntil: Date;
  reason: string;
}

export function computeCooldownBan(
  banCount: number,
  lastBanAt: Date | null,
  now: Date = new Date(),
): CooldownBanResult {
  const withinWindow =
    lastBanAt != null && now.getTime() - lastBanAt.getTime() < BAN_WINDOW_MS;
  const newCount = withinWindow && banCount >= 1 ? banCount + 1 : 1;

  let bannedUntil: Date;
  let reason: string;

  if (newCount >= 3) {
    bannedUntil = new Date(0); // sentinel — permanent
    reason = `auto: permanent after ${newCount} bans within 30 days`;
  } else if (newCount === 2) {
    bannedUntil = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    reason = `auto: 72h cooldown — gold accuracy below threshold after 1 prior ban`;
  } else {
    bannedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    reason = `auto: 24h cooldown — gold accuracy below threshold`;
  }

  return { banCount: newCount, bannedUntil, reason };
}

export function isPermanentlyBanned(
  isBanned: boolean,
  bannedUntil: Date | null,
  banCount: number,
): boolean {
  return isBanned && bannedUntil != null && bannedUntil.getTime() === 0 && banCount >= 3;
}

export function isInCooldown(
  isBanned: boolean,
  bannedUntil: Date | null,
): boolean {
  if (!isBanned || !bannedUntil) return false;
  if (bannedUntil.getTime() === 0) return false; // permanent
  return new Date() < bannedUntil;
}

export function isInRetest(
  isBanned: boolean,
  bannedUntil: Date | null,
  banCount: number,
): boolean {
  if (!isBanned || !bannedUntil) return false;
  if (bannedUntil.getTime() === 0) return false; // permanent
  return new Date() >= bannedUntil && banCount < 3;
}

// Pure rule used by both /api/submit and the ban endpoint. Mirrors the
// submission flow at app/api/submit/route.ts — keep them in sync.
export interface BanCheckInput {
  goldAttempted: number;
  goldCorrect: number;
}
export interface BanCheckResult {
  shouldBan: boolean;
  reason: string | null;
}
export function evaluateBanRule(input: BanCheckInput): BanCheckResult {
  if (input.goldAttempted < 3) {
    return { shouldBan: false, reason: null };
  }
  if (input.goldCorrect / input.goldAttempted < 0.5) {
    return {
      shouldBan: true,
      reason: `auto: gold accuracy ${input.goldCorrect}/${input.goldAttempted} < 50% after 3+ attempts`,
    };
  }
  return { shouldBan: false, reason: null };
}

export function truncateAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface TimeSeriesPoint {
  hour: string;
  count: number;
}

export interface PayoutTimeSeriesPoint {
  hour: string;
  amountWei: string;
}

export interface GoldPassRateStats {
  totalAttempted: number;
  totalCorrect: number;
  ratePct: number | null;
}

export interface GoldAccuracyBucket {
  accuracyRange: string;
  count: number;
}

export interface CategoryDistribution {
  category: string;
  count: number;
}

export interface OpsDashboardData {
  submissionVolume24h: TimeSeriesPoint[];
  payoutVolume24h: PayoutTimeSeriesPoint[];
  goldPassRate: GoldPassRateStats;
  goldAccuracyDistribution: GoldAccuracyBucket[];
  categoryDistribution: CategoryDistribution[];
}

export async function getOpsDashboardData(): Promise<OpsDashboardData> {
  const [
    submissionVolume24h,
    payoutVolume24h,
    goldPassRate,
    goldAccuracyDistribution,
    categoryDistribution,
  ] = await Promise.all([
    getSubmissionVolume24h(),
    getPayoutVolume24h(),
    getGoldPassRateStats(),
    getGoldAccuracyDistribution(),
    getCategoryDistribution(),
  ]);

  return {
    submissionVolume24h,
    payoutVolume24h,
    goldPassRate,
    goldAccuracyDistribution,
    categoryDistribution,
  };
}

async function getSubmissionVolume24h(): Promise<TimeSeriesPoint[]> {
  const rows = await prisma.$queryRaw<{ hour: Date; count: bigint }[]>`
    SELECT date_trunc('hour', "createdAt") as hour, COUNT(*)::int as count
    FROM submissions
    WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
    GROUP BY hour
    ORDER BY hour ASC
  `;
  return rows.map((r) => ({
    hour: r.hour.toISOString(),
    count: Number(r.count),
  }));
}

async function getPayoutVolume24h(): Promise<PayoutTimeSeriesPoint[]> {
  const rows = await prisma.$queryRaw<{ hour: Date; amount_wei: bigint }[]>`
    SELECT date_trunc('hour', "createdAt") as hour, COALESCE(SUM("payoutAmountWei"), 0) as amount_wei
    FROM submissions
    WHERE "createdAt" >= NOW() - INTERVAL '24 hours' AND "payoutStatus" = 'sent'
    GROUP BY hour
    ORDER BY hour ASC
  `;
  return rows.map((r) => ({
    hour: r.hour.toISOString(),
    amountWei: String(r.amount_wei),
  }));
}

async function getGoldPassRateStats(): Promise<GoldPassRateStats> {
  const aggregate = await prisma.user.aggregate({
    _sum: { goldAttempted: true, goldCorrect: true },
  });
  const totalAttempted = aggregate._sum.goldAttempted ?? 0;
  const totalCorrect = aggregate._sum.goldCorrect ?? 0;
  const ratePct = totalAttempted > 0 ? Math.round((totalCorrect / totalAttempted) * 100) : null;
  return { totalAttempted, totalCorrect, ratePct };
}

export async function getGoldAccuracyDistribution(): Promise<GoldAccuracyBucket[]> {
  const rows = await prisma.$queryRaw<{ bucket: string; count: bigint }[]>`
    SELECT
      CASE
        WHEN "goldAttempted" = 0 THEN 'N/A'
        WHEN "goldCorrect" * 1.0 / "goldAttempted" >= 0.9 THEN '90-100%'
        WHEN "goldCorrect" * 1.0 / "goldAttempted" >= 0.7 THEN '70-89%'
        WHEN "goldCorrect" * 1.0 / "goldAttempted" >= 0.5 THEN '50-69%'
        ELSE '<50%'
      END AS bucket,
      COUNT(*)::int AS count
    FROM "users"
    GROUP BY bucket
    ORDER BY bucket
  `;
  const result: Record<string, number> = {
    "N/A": 0,
    "90-100%": 0,
    "70-89%": 0,
    "50-69%": 0,
    "<50%": 0,
  };
  for (const r of rows) {
    result[r.bucket] = Number(r.count);
  }
  return Object.entries(result).map(([accuracyRange, count]) => ({
    accuracyRange,
    count,
  }));
}

async function getCategoryDistribution(): Promise<CategoryDistribution[]> {
  const rows = await prisma.$queryRaw<{ category: string | null; count: bigint }[]>`
    SELECT t.category, COUNT(*)::int as count
    FROM submissions s
    JOIN tasks t ON s."taskId" = t.id
    GROUP BY t.category
    ORDER BY count DESC
  `;
  return rows.map((r) => ({
    category: r.category ?? "uncategorized",
    count: Number(r.count),
  }));
}
