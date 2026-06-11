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
  overrides: Partial<{ id: string; adminUserId: string; name: string; defaultResponseTarget: number; rewardWei: bigint }> = {},
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
      rewardWei: overrides.rewardWei ?? 50000000000000000n,
    },
  });
}

export async function createUser(
  overrides: Partial<{
    walletAddress: string;
    isBanned: boolean;
    banCount: number;
    bannedUntil: Date | null;
    lastBanAt: Date | null;
    goldCorrect: number;
    goldAttempted: number;
  }> = {},
) {
  return db.user.create({
    data: {
      walletAddress: overrides.walletAddress ?? makeWallet(),
      isBanned: overrides.isBanned ?? false,
      banCount: overrides.banCount ?? (overrides.isBanned ? 1 : 0),
      bannedUntil: overrides.bannedUntil ?? null,
      lastBanAt: overrides.lastBanAt ?? null,
      goldCorrect: overrides.goldCorrect ?? 0,
      goldAttempted: overrides.goldAttempted ?? 0,
    },
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

export async function createGoldTask(goldAnswer: "A" | "B" = "A") {
  return createTask({ isGold: true, goldAnswer });
}

export async function seedSubmissions(
  wallet: string,
  count: number,
  choice: "A" | "B",
  reason = VALID_REASON,
) {
  await db.user.upsert({
    where: { walletAddress: wallet },
    create: { walletAddress: wallet },
    update: {},
  });
  const tasks = await Promise.all(
    Array.from({ length: count }).map(() => createTask()),
  );
  await db.submission.createMany({
    data: tasks.map((t) => ({
      walletAddress: wallet,
      taskId: t.id,
      choice,
      reason,
      payoutAmountWei: 0n,
      payoutStatus: "skipped",
    })),
  });
  return tasks;
}
