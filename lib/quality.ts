import prisma from "./prisma";

export function isSpamReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length < 10) return true;
  if (/^(.)\1+$/.test(trimmed)) return true;
  return false;
}

export interface IaaResult {
  majorityAnswer: string;
  agreementScore: number;
  aCount: number;
  bCount: number;
  totalCount: number;
}

export function computeAgreementFromCounts(aCount: number, bCount: number): IaaResult | null {
  const totalCount = aCount + bCount;
  if (totalCount < 2) return null;

  const majorityAnswer = aCount >= bCount ? "A" : "B";
  const maxCount = Math.max(aCount, bCount);
  const agreementScore = maxCount / totalCount;

  return { majorityAnswer, agreementScore, aCount, bCount, totalCount };
}

export async function computeIAA(taskId: string): Promise<IaaResult | null> {
  const submissions = await prisma.submission.findMany({
    where: {
      taskId,
      isGoldCheck: false,
      payoutStatus: { in: ["sent", "confirmed"] },
    },
    select: { choice: true },
  });

  const aCount = submissions.filter((s) => s.choice === "A").length;
  const bCount = submissions.length - aCount;

  return computeAgreementFromCounts(aCount, bCount);
}
