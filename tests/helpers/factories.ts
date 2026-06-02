import type { PrismaClient } from "@/app/generated/prisma/client";
import { prisma } from "./db";

let walletCounter = 0;

export function makeWallet(seed?: number): string {
  const n = seed ?? ++walletCounter;
  return `0x${n.toString(16).padStart(40, "0")}`;
}

export function makeTaskId(seed?: number): string {
  const n = seed ?? Math.floor(Math.random() * 1e15);
  return `task-${n.toString(16).padStart(8, "0")}`;
}

export const db = prisma as PrismaClient;
export const VALID_REASON = "Response A is clearer and more accurate overall.";

export async function createUser(
  overrides: Partial<{ walletAddress: string; isBanned: boolean; goldCorrect: number; goldAttempted: number }> = {},
) {
  return db.user.create({
    data: {
      walletAddress: overrides.walletAddress ?? makeWallet(),
      isBanned: overrides.isBanned ?? false,
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
