import prisma from "@/lib/prisma";

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly balanceStroops: bigint,
    public readonly requiredStroops: bigint,
  ) {
    super(`Campaign balance insufficient: have ${balanceStroops}, need ${requiredStroops}`);
    this.name = "InsufficientBalanceError";
  }
}

export function getPlatformFeeStroops(): bigint {
  const raw = process.env.PLATFORM_FEE_STROOPS;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("PLATFORM_FEE_STROOPS env var is required and must be a non-negative integer string");
  }
  return BigInt(raw);
}

// Single source of truth for the per-submission debit/refund amount so the
// labeler reward + platform fee is never computed inconsistently across the
// debit site (checkAndDebit) and the refund sites in the submit route.
export function totalDebitStroops(labelerRewardStroops: bigint): bigint {
  return labelerRewardStroops + getPlatformFeeStroops();
}

export async function checkAndDebit(
  campaignId: string,
  labelerRewardStroops: bigint,
  submissionId: string,
): Promise<void> {
  const platformFeeStroops = getPlatformFeeStroops();
  const required = totalDebitStroops(labelerRewardStroops);

  await prisma.$transaction(async (tx) => {
    // Acquire a row-level lock on the campaign balance for the duration of the
    // transaction. Under READ COMMITTED two concurrent submissions for the same
    // campaign could otherwise both read the same balance, both pass the check,
    // and both debit (TOCTOU / overselling). FOR UPDATE serializes them.
    const locked = await tx.$queryRaw<{ balanceStroops: bigint }[]>`
      SELECT "balanceStroops" FROM "campaign_balances"
      WHERE "campaignId" = ${campaignId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.balanceStroops ?? 0n;

    if (currentBalance < required) {
      throw new InsufficientBalanceError(currentBalance, required);
    }

    await tx.campaignBalance.update({
      where: { campaignId },
      data: { balanceStroops: { decrement: required } },
    });

    await tx.balanceLedger.createMany({
      data: [
        { campaignId, type: "DEBIT_REWARD", amountStroops: labelerRewardStroops, submissionId },
        { campaignId, type: "DEBIT_FEE", amountStroops: platformFeeStroops, submissionId },
      ],
    });
  });
}

export async function creditBalance(
  campaignId: string,
  amountStroops: bigint,
  note?: string,
  type: "DEPOSIT" | "REFUND" = "DEPOSIT",
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.campaignBalance.upsert({
      where: { campaignId },
      create: { campaignId, balanceStroops: amountStroops },
      update: { balanceStroops: { increment: amountStroops } },
    });

    // Query the updated row explicitly — upsert may return the pre-increment value in some Prisma versions
    const updated = await tx.campaignBalance.findUnique({
      where: { campaignId },
      select: { balanceStroops: true },
    });

    await tx.balanceLedger.create({
      data: { campaignId, type, amountStroops, note: note ?? null },
    });

    return updated!.balanceStroops;
  });

  return result;
}

export async function getBalanceSummary(
  campaignId: string,
  campaignRewardStroops: bigint,
): Promise<{ balanceStroops: bigint; estimatedSubmissionsRemaining: number | null }> {
  const balance = await prisma.campaignBalance.findUnique({
    where: { campaignId },
    select: { balanceStroops: true },
  });

  const balanceStroops = balance?.balanceStroops ?? 0n;

  let estimatedSubmissionsRemaining: number | null = null;
  try {
    const platformFeeStroops = getPlatformFeeStroops();
    const costPerSubmission = campaignRewardStroops + platformFeeStroops;
    if (costPerSubmission > 0n) {
      estimatedSubmissionsRemaining = Number(balanceStroops / costPerSubmission);
    }
  } catch {
    // PLATFORM_FEE_STROOPS not configured — estimate unavailable
  }

  return { balanceStroops, estimatedSubmissionsRemaining };
}
