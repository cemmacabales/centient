import type { PrismaClient } from "@/app/generated/prisma/client";
import { prisma } from "./db";

let walletCounter = 0;
let campaignCounter = 0;
let taskIdCounter = 0;

export function makeWallet(seed?: number): string {
  const n = seed ?? ++walletCounter;
  return `0x${n.toString(16).padStart(40, "0")}`;
}

export function makeTaskId(seed?: number): string {
  const n = seed ?? ++taskIdCounter;
  return `task-${n.toString(16).padStart(8, "0")}`;
}

export function makeCampaignId(): string {
  const n = ++campaignCounter;
  return `campaign-${n.toString(16).padStart(8, "0")}`;
}

export const db = prisma as PrismaClient;
export const VALID_REASON = "Response A is clearer and more accurate overall.";

export async function createAdminUser(
  overrides: Partial<{ id: string; email: string; role: string }> = {},
) {
  return db.adminUser.create({
    data: {
      id: overrides.id ?? `admin-${++campaignCounter}`,
      email: overrides.email ?? "test@test.com",
      passwordHash: "hashed",
      role: (overrides.role as any) ?? "SUPER_ADMIN",
      isVerified: true,
    },
  });
}

export async function createCampaign(
  overrides: Partial<{ id: string; adminUserId: string; name: string; defaultResponseTarget: number; rewardUnits: bigint }> = {},
) {
  if (!overrides.adminUserId) {
    const admin = await createAdminUser();
    overrides.adminUserId = admin.id;
  }
  return db.campaign.create({
    data: {
      id: overrides.id ?? makeCampaignId(),
      adminUserId: overrides.adminUserId,
      name: overrides.name ?? "Test Campaign",
      defaultResponseTarget: overrides.defaultResponseTarget ?? 3,
      rewardUnits: overrides.rewardUnits ?? 50000000000000000n,
    },
  });
}

export async function createCampaignBalance(
  campaignId: string,
  balanceUnits: bigint = 0n,
) {
  return db.campaignBalance.upsert({
    where: { campaignId },
    create: { campaignId, balanceUnits },
    update: { balanceUnits },
  });
}

export async function createUser(
  overrides: Partial<{
    walletAddress: string | null;
    email: string | null;
    isBanned: boolean;
    banCount: number;
    bannedUntil: Date | null;
    lastBanAt: Date | null;
    goldCorrect: number;
    goldAttempted: number;
    pendingBalanceUnits: bigint;
  }> = {},
) {
  // An explicit `walletAddress: null` models an email-only labeler (ST-5d); when the
  // key is omitted the factory generates a wallet for the common wallet-linked case.
  const walletAddress =
    "walletAddress" in overrides ? overrides.walletAddress ?? null : makeWallet();
  const user = await db.user.create({
    data: {
      walletAddress,
      email: overrides.email ?? null,
      isBanned: overrides.isBanned ?? false,
      banCount: overrides.banCount ?? (overrides.isBanned ? 1 : 0),
      bannedUntil: overrides.bannedUntil ?? null,
      lastBanAt: overrides.lastBanAt ?? null,
      goldCorrect: overrides.goldCorrect ?? 0,
      goldAttempted: overrides.goldAttempted ?? 0,
      pendingBalanceUnits: overrides.pendingBalanceUnits ?? 0n,
    },
  });
  // walletAddress is nullable on User; most call sites create wallet-keyed users, so
  // narrow it back to a non-null string for ergonomic call sites. Tests that pass an
  // explicit null assert on the persisted row (via prisma), not this return value.
  return { ...user, walletAddress: user.walletAddress as string };
}

export async function createUserBalance(
  userId: string,
  pendingBalanceUnits: bigint = 0n,
) {
  return db.user.update({
    where: { id: userId },
    data: { pendingBalanceUnits },
  });
}

export async function createTask(
  overrides: Partial<{
    id: string;
    prompt: string;
    responseA: string;
    responseB: string;
    isGold: boolean;
    goldAnswer: "A" | "B" | null;
    campaignId: string | null;
    responseTarget: number | null;
    category: string | null;
    createdAt: Date;
  }> = {},
) {
  return db.task.create({
    data: {
      id: overrides.id ?? makeTaskId(),
      prompt: overrides.prompt ?? "Test prompt?",
      responseA: overrides.responseA ?? "Response A",
      responseB: overrides.responseB ?? "Response B",
      isGold: overrides.isGold ?? false,
      goldAnswer: overrides.goldAnswer ?? null,
      campaignId: overrides.campaignId ?? null,
      responseTarget: overrides.responseTarget ?? null,
      category: overrides.category ?? null,
      createdAt: overrides.createdAt ?? undefined,
    },
  });
}

export async function createGoldTask(
  goldAnswerOrOverrides: "A" | "B" | Partial<Parameters<typeof createTask>[0]> = "A",
) {
  if (typeof goldAnswerOrOverrides === "string") {
    return createTask({ isGold: true, goldAnswer: goldAnswerOrOverrides });
  }
  const { goldAnswer = "A", ...rest } = goldAnswerOrOverrides;
  return createTask({ isGold: true, goldAnswer, ...rest });
}

export async function seedSubmissions(
  wallet: string,
  count: number,
  choice: "A" | "B",
  reason = VALID_REASON,
) {
  // Ensure user exists
  await db.user.upsert({
    where: { walletAddress: wallet },
    create: { walletAddress: wallet },
    update: {},
  });
  // Fetch the user to get the surrogate id
  const user = await db.user.findUnique({
    where: { walletAddress: wallet },
    select: { id: true },
  });
  if (!user) {
    throw new Error(`User not found for wallet ${wallet}`);
  }
  const tasks = await Promise.all(
    Array.from({ length: count }).map(() => createTask()),
  );
  await db.submission.createMany({
    data: tasks.map((t) => ({
      walletAddress: wallet,
      userId: user.id,
      taskId: t.id,
      choice,
      reason,
      payoutAmountUnits: 0,
      payoutStatus: "skipped",
    })),
  });
  return tasks;
}

/**
 * Seed `count` skipped submissions for an existing user, keyed on `userId`
 * (identity as of ST-5d). The submission's walletAddress mirrors the user's
 * linked wallet — null for email-only accounts.
 */
export async function seedSubmissionsForUser(
  userId: string,
  count: number,
  choice: "A" | "B",
  reason = VALID_REASON,
) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { walletAddress: true },
  });
  const tasks = await Promise.all(
    Array.from({ length: count }).map(() => createTask()),
  );
  await db.submission.createMany({
    data: tasks.map((t) => ({
      walletAddress: user.walletAddress,
      userId,
      taskId: t.id,
      choice,
      reason,
      payoutAmountUnits: 0,
      payoutStatus: "skipped",
    })),
  });
  return tasks;
}
