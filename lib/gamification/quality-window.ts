// The reads behind tiers and stamps (#202). Each takes the client it runs on,
// so the tier and stamp writes can read inside their own transaction.
//
// Quality checks: gold rows with a verdict, retest kept out (retest decides a
// ban, not a tier). Crowd: settled, non-gold answers on resolved tasks, ties
// kept out, since a 50/50 task's recorded majority is only the tie-break.

import { Prisma } from "@/app/generated/prisma/client";
import { REWARDED_STATUSES, SETTLED_STATUSES } from "@/lib/constants";
import { STAMP_RULES, type StampStats } from "./stamps";
import { TIER_RULES, type TierSignals } from "./tiers";

type Db = Prisma.TransactionClient;

/** Gold rows that count as a quality check toward tiers and stamps. */
export const countedCheck = { isGoldCheck: true, retest: false, goldPassed: { not: null } } as const;

/** Every answer the labeler saw accepted: paid answers and passed checks. */
export function accepted(userId: string): Prisma.SubmissionWhereInput {
  return {
    userId,
    OR: [
      { isGoldCheck: false, payoutStatus: { in: [...REWARDED_STATUSES] } },
      { ...countedCheck, goldPassed: true },
    ],
  };
}

/** Verdicts of the last `take` checks, newest first. */
async function lastChecks(db: Db, userId: string, take: number): Promise<boolean[]> {
  const rows = await db.submission.findMany({
    where: { userId, ...countedCheck },
    orderBy: { createdAt: "desc" },
    take,
    select: { goldPassed: true },
  });
  return rows.map((r) => r.goldPassed === true);
}

/** Answers that can match the crowd. Raw SQL: the match compares two columns. */
function crowdAnswers(userId: string): Prisma.Sql {
  return Prisma.sql`
    FROM "submissions" s JOIN "tasks" t ON t.id = s."taskId"
    WHERE s."userId" = ${userId}
      AND s."isGoldCheck" = false
      AND s."payoutStatus" IN (${Prisma.join([...SETTLED_STATUSES])})
      AND t."resolvedAt" IS NOT NULL
      AND t."majorityAnswer" IS NOT NULL
      AND t."agreementScore" <> 0.5`;
}

async function crowdWindow(db: Db, userId: string): Promise<TierSignals["crowd"]> {
  const [row] = await db.$queryRaw<TierSignals["crowd"][]>`
    SELECT COUNT(*) FILTER (WHERE w.choice = w."majorityAnswer")::int AS matched, COUNT(*)::int AS total
    FROM (
      SELECT s.choice, t."majorityAnswer" ${crowdAnswers(userId)}
      ORDER BY s."createdAt" DESC
      LIMIT ${TIER_RULES.crowdWindow}
    ) w`;
  return row ?? { matched: 0, total: 0 };
}

async function crowdMatches(db: Db, userId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n ${crowdAnswers(userId)} AND s.choice = t."majorityAnswer"`;
  return row?.n ?? 0;
}

export async function readTierSignals(db: Db, userId: string): Promise<TierSignals> {
  const [user, checks, crowd, activeDays] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { xp: true } }),
    lastChecks(db, userId, TIER_RULES.checkWindow),
    crowdWindow(db, userId),
    db.dailyProgress.count({ where: { userId, counted: { gt: 0 } } }),
  ]);
  return {
    xp: user.xp,
    checks: { passed: checks.filter(Boolean).length, total: checks.length },
    crowd,
    activeDays,
  };
}

export async function readStampStats(db: Db, userId: string): Promise<StampStats> {
  const [user, answers, payouts, run, matches, categories, healthAnswers] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { bestStreak: true } }),
    db.submission.count({ where: accepted(userId) }),
    db.submission.count({ where: { userId, isGoldCheck: false, payoutStatus: { in: [...SETTLED_STATUSES] } } }),
    lastChecks(db, userId, STAMP_RULES.sharpEyeRun),
    crowdMatches(db, userId),
    db.task.findMany({
      where: { category: { not: null }, submissions: { some: accepted(userId) } },
      distinct: ["category"],
      select: { category: true },
    }),
    db.submission.count({ where: { ...accepted(userId), task: { category: STAMP_RULES.healthCategory } } }),
  ]);
  const firstMiss = run.indexOf(false);
  return {
    answers,
    payouts,
    bestStreak: user.bestStreak,
    checkRun: firstMiss === -1 ? run.length : firstMiss,
    crowdMatches: matches,
    categories: categories.length,
    healthAnswers,
  };
}
