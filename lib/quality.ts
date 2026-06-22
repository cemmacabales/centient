import prisma from "@/lib/prisma";

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

export function normalizeReason(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

export async function checkReasonRepetition(
  walletAddress: string,
  newReason: string,
): Promise<{ isRepetitive: boolean }> {
  const window = parseInt(process.env.REASON_REPEAT_WINDOW ?? "10", 10);
  const max = parseInt(process.env.REASON_REPEAT_MAX ?? "3", 10);
  const jaccardThreshold = parseFloat(process.env.REASON_REPEAT_JACCARD_THRESHOLD ?? "0.8");
  const jaccardMinCount = parseInt(process.env.REASON_REPEAT_JACCARD_MIN_COUNT ?? "5", 10);

  const recent = await prisma.submission.findMany({
    where: { walletAddress },
    orderBy: { createdAt: "desc" },
    take: window - 1,
    select: { reason: true },
  });

  const normalizedNew = normalizeReason(newReason);
  const reasons = [normalizedNew, ...recent.map((r) => normalizeReason(r.reason))];

  let exactCount = 0;
  for (const r of reasons) {
    if (r === normalizedNew) exactCount++;
  }
  if (exactCount >= max) {
    return { isRepetitive: true };
  }

  const newTokens = new Set(normalizedNew.split(/\s+/).filter(Boolean));
  if (newTokens.size === 0) return { isRepetitive: false };

  let nearCount = 0;
  for (const r of reasons) {
    if (r === normalizedNew) continue;
    const score = jaccardSimilarity(normalizedNew, r);
    if (score > jaccardThreshold) nearCount++;
  }
  if (nearCount >= jaccardMinCount) {
    return { isRepetitive: true };
  }

  return { isRepetitive: false };
}
