// Matched the crowd (#202, ADR-0011): +5 XP for each settled answer that agrees
// with a task's majority, written by the payout worker after the payout has
// persisted. XP is never money, and nothing here touches the payout rail.
//
// A tie earns nothing: its recorded majority ("A") is only the tie-break. Each
// award is keyed `crowd:<submissionId>`, so a repeated call awards nothing.

import prisma from "@/lib/prisma";
import { SETTLED_STATUSES } from "@/lib/constants";
import { updateStanding } from "./standing";
import { manilaDayKey, manilaWeekKey } from "./time";

export const CROWD_MATCH_XP = 5;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/** Award one answer's crowd XP. False if it was already awarded. */
async function awardMatch(userId: string, submissionId: string, at: Date): Promise<boolean> {
  try {
    await prisma.$transaction([
      prisma.xpEvent.create({
        data: {
          userId,
          kind: "CROWD_MATCH",
          amount: CROWD_MATCH_XP,
          submissionId,
          dedupeKey: `crowd:${submissionId}`,
          dayKey: manilaDayKey(at),
          weekKey: manilaWeekKey(at),
        },
      }),
      prisma.user.update({ where: { id: userId }, data: { xp: { increment: CROWD_MATCH_XP } } }),
    ]);
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Crowd XP and standing for a settled answer on a resolved task. When the task
 * has just resolved, every settled answer on it is judged; when it resolved
 * earlier, only this one, which settled late.
 */
export async function recordCrowd({
  taskId,
  submissionId,
  resolvedNow,
  at = new Date(),
}: {
  taskId: string;
  submissionId: string;
  resolvedNow: boolean;
  at?: Date;
}): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { isGold: true, majorityAnswer: true, agreementScore: true, resolvedAt: true },
  });
  if (!task || task.isGold || !task.resolvedAt || !task.majorityAnswer || task.agreementScore === 0.5) return;

  const answers = await prisma.submission.findMany({
    where: {
      taskId,
      isGoldCheck: false,
      payoutStatus: { in: [...SETTLED_STATUSES] },
      ...(resolvedNow ? {} : { id: submissionId }),
    },
    select: { id: true, userId: true, choice: true },
    orderBy: { createdAt: "asc" },
  });

  let firstError: unknown = null;
  for (const a of answers) {
    // One labeler's failure doesn't cost the others their XP.
    try {
      const matched = a.choice === task.majorityAnswer;
      if (matched && !(await awardMatch(a.userId, a.id, at))) continue;
      await updateStanding(a.userId, matched ? "crowd_match" : "crowd_miss");
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
}
