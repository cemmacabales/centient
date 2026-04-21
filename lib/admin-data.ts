import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import prisma from "./prisma";
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
}

export interface TaskDetail {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  category: string | null;
  isGold: boolean;
  goldAnswer: string | null;
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
  recentSubmissions: TaskTableSubmission[];
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
    recentSubmissions: t.submissions.map((s) => ({
      id: s.id,
      walletAddress: s.walletAddress,
      choice: s.choice,
      reason: s.reason,
      payoutStatus: s.payoutStatus,
      payoutTxHash: s.payoutTxHash,
      createdAt: s.createdAt.toISOString(),
    })),
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
    recentSubmissions: task.submissions,
  };
}

export async function getWalletRows(): Promise<WalletRow[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
  });
  return users.map((u) => ({
    walletAddress: u.walletAddress,
    createdAt: u.createdAt,
    submissionCount: u.submissionCount,
    totalEarned: formatUnits(u.totalEarnedWei, REWARD_TOKEN_DECIMALS),
    goldCorrect: u.goldCorrect,
    goldAttempted: u.goldAttempted,
    goldAccuracyPct:
      u.goldAttempted === 0 ? null : Math.round((u.goldCorrect / u.goldAttempted) * 100),
    isBanned: u.isBanned,
  }));
}

export function truncateAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
