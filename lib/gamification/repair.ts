// The XP write sits after the accepted answer's transaction (#201, ADR-0010),
// so a failure there leaves an accepted answer without its ANSWER event. This
// re-derives exactly those. It restores the XP only: the day's goal count and
// the streak stay as they stood, because settling a past day now would rewrite
// a streak the labeler has already seen.

import prisma from "@/lib/prisma";
import { REWARDED_STATUSES } from "@/lib/constants";
import { answerXp } from "./rules";
import { manilaDayKey, manilaWeekKey } from "./time";

export interface RepairReport {
  missing: { submissionId: string; userId: string; amount: number }[];
  applied: number;
}

export async function repairMissingAnswerXp({ since, apply }: { since: Date; apply: boolean }): Promise<RepairReport> {
  const accepted = await prisma.submission.findMany({
    where: {
      createdAt: { gte: since },
      isGoldCheck: false,
      payoutStatus: { in: [...REWARDED_STATUSES] },
    },
    select: { id: true, userId: true, createdAt: true, task: { select: { difficulty: true } } },
    orderBy: { createdAt: "asc" },
  });
  const recorded = new Set(
    (
      await prisma.xpEvent.findMany({
        where: { kind: "ANSWER", submissionId: { in: accepted.map((s) => s.id) } },
        select: { submissionId: true },
      })
    ).map((e) => e.submissionId),
  );

  const todo = accepted.filter((s) => !recorded.has(s.id));
  const missing = todo.map((s) => ({ submissionId: s.id, userId: s.userId, amount: answerXp(s.task.difficulty) }));
  if (!apply) return { missing, applied: 0 };

  let applied = 0;
  for (const s of todo) {
    const amount = answerXp(s.task.difficulty);
    try {
      await prisma.$transaction([
        prisma.xpEvent.create({
          data: {
            userId: s.userId,
            kind: "ANSWER",
            amount,
            submissionId: s.id,
            dedupeKey: `answer:${s.id}`,
            dayKey: manilaDayKey(s.createdAt),
            weekKey: manilaWeekKey(s.createdAt),
            createdAt: s.createdAt,
          },
        }),
        prisma.user.update({ where: { id: s.userId }, data: { xp: { increment: amount } } }),
      ]);
      applied++;
    } catch (err) {
      // Recorded by a live request since the read above.
      if ((err as { code?: unknown } | null)?.code !== "P2002") throw err;
    }
  }
  return { missing, applied };
}
