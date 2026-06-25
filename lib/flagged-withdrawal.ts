import prisma from "@/lib/prisma";
import {
  FlaggedWithdrawalReason,
  FlaggedWithdrawalStatus,
  Prisma,
} from "@/app/generated/prisma/client";

export { FlaggedWithdrawalReason, FlaggedWithdrawalStatus };

/**
 * Risk severity per trigger, used to prioritise the admin review queue (P4c).
 * A banned identity is the most urgent (a known-bad actor cashing out); a failed
 * eligibility gate is the least (often just a too-new or low-quality account).
 */
export type FlaggedWithdrawalSeverity = "CRITICAL" | "HIGH" | "LOW";

const SEVERITY_BY_REASON: Record<FlaggedWithdrawalReason, FlaggedWithdrawalSeverity> = {
  BANNED_IDENTITY: "CRITICAL",
  SHARED_WALLET: "HIGH",
  INELIGIBLE: "LOW",
};

const SEVERITY_RANK: Record<FlaggedWithdrawalSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  LOW: 2,
};

export function severityForReason(reason: FlaggedWithdrawalReason): FlaggedWithdrawalSeverity {
  return SEVERITY_BY_REASON[reason];
}

export function severityRank(reason: FlaggedWithdrawalReason): number {
  return SEVERITY_RANK[severityForReason(reason)];
}

export interface RecordFlaggedWithdrawalParams {
  userId: string;
  walletAddress: string | null;
  reason: FlaggedWithdrawalReason;
  detail?: Prisma.InputJsonValue;
  balanceWei: bigint;
}

/**
 * Record a blocked withdrawal attempt for admin review. Idempotent per
 * (userId, reason) while PENDING: a labeler who retries a blocked withdrawal
 * refreshes the existing open flag instead of spamming the queue with duplicates.
 * Best-effort — recording a flag must never turn a clean 403 rejection into a 500,
 * so callers treat a throw here as non-fatal.
 */
export async function recordFlaggedWithdrawal(
  params: RecordFlaggedWithdrawalParams,
): Promise<void> {
  const { userId, walletAddress, reason, detail, balanceWei } = params;

  const existing = await prisma.flaggedWithdrawal.findFirst({
    where: { userId, reason, status: "PENDING" },
    select: { id: true },
  });

  if (existing) {
    await prisma.flaggedWithdrawal.update({
      where: { id: existing.id },
      data: {
        walletAddress,
        detail: detail ?? Prisma.JsonNull,
        balanceWei,
      },
    });
    return;
  }

  await prisma.flaggedWithdrawal.create({
    data: {
      userId,
      walletAddress,
      reason,
      detail: detail ?? Prisma.JsonNull,
      balanceWei,
    },
  });
}
