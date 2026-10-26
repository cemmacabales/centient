// Weekly quests against the database (#203, ADR-0012). The rules are in
// quests.ts. A quest is awarded on the answer or passed check that completes
// it, right after that answer's XP commits and before its tier is weighed, so
// quest XP can open a tier. Never in the payout worker.
//
// Each award is keyed quest:<questId>:<userId>:<weekKey>, so a quest pays once
// a week however many answers race to complete it.

import prisma from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { STAMP_RULES } from "./stamps";
import { accepted, countedCheck } from "./quality-window";
import { newlyComplete, QUEST_XP, questProgress, type QuestStats, type QuestStatus } from "./quests";
import { captureServer } from "./server-analytics";
import { addDays, dayStartUtc, manilaDayKey, weekKeyOf } from "./time";
import type { ProgressLine } from "./types";

type Db = Prisma.TransactionClient;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

const questKey = (questId: string, userId: string, weekKey: string) => `quest:${questId}:${userId}:${weekKey}`;

async function readQuestStats(db: Db, userId: string, weekKey: string): Promise<QuestStats> {
  const inWeek = { gte: dayStartUtc(weekKey), lt: dayStartUtc(addDays(weekKey, 7)) };
  const [healthAnswers, checksPassed, goalDays] = await Promise.all([
    db.submission.count({
      where: { ...accepted(userId), createdAt: inWeek, task: { category: STAMP_RULES.healthCategory } },
    }),
    db.submission.count({ where: { userId, ...countedCheck, goldPassed: true, createdAt: inWeek } }),
    db.dailyProgress.count({ where: { userId, goalMet: true, dayKey: { gte: weekKey, lte: addDays(weekKey, 6) } } }),
  ]);
  return { healthAnswers, checksPassed, goalDays };
}

async function awardedThisWeek(db: Db, userId: string, weekKey: string): Promise<Set<string>> {
  const rows = await db.xpEvent.findMany({ where: { userId, weekKey, kind: "QUEST" }, select: { dedupeKey: true } });
  return new Set(rows.map((r) => r.dedupeKey.split(":")[1]));
}

/** Award every quest this answer completed. Returns the receipt lines. */
export async function awardQuests(userId: string, at: Date = new Date()): Promise<ProgressLine[]> {
  const dayKey = manilaDayKey(at);
  const weekKey = weekKeyOf(dayKey);
  const [stats, awarded] = await Promise.all([readQuestStats(prisma, userId, weekKey), awardedThisWeek(prisma, userId, weekKey)]);

  const lines: ProgressLine[] = [];
  for (const questId of newlyComplete(stats, awarded)) {
    try {
      await prisma.$transaction([
        prisma.xpEvent.create({
          data: { userId, kind: "QUEST", amount: QUEST_XP, dedupeKey: questKey(questId, userId, weekKey), dayKey, weekKey, createdAt: at },
        }),
        prisma.user.update({ where: { id: userId }, data: { xp: { increment: QUEST_XP } } }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
    lines.push({ kind: "QUEST", amount: QUEST_XP, quest: questId });
    captureServer(userId, "quest_completed", { quest: questId, xp: QUEST_XP });
  }
  return lines;
}

/** This week's quests for Progress → This week. */
export async function readQuests(userId: string, at: Date = new Date()): Promise<QuestStatus[]> {
  const weekKey = weekKeyOf(manilaDayKey(at));
  const [stats, awarded] = await Promise.all([readQuestStats(prisma, userId, weekKey), awardedThisWeek(prisma, userId, weekKey)]);
  return questProgress(stats, awarded);
}
