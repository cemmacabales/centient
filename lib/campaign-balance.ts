import prisma from "@/lib/prisma";

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly balanceUnits: bigint,
    public readonly requiredUnits: bigint,
  ) {
    super(`Campaign balance insufficient: have ${balanceUnits}, need ${requiredUnits}`);
    this.name = "InsufficientBalanceError";
  }
}

export function getPlatformFeeUnits(): bigint {
  const raw = process.env.PLATFORM_FEE_UNITS;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("PLATFORM_FEE_UNITS env var is required and must be a non-negative integer string");
  }
  return BigInt(raw);
}

// Single source of truth for the per-submission debit/refund amount so the
// labeler reward + platform fee is never computed inconsistently across the
// debit site (checkAndDebit) and the refund sites in the submit route.
export function totalDebitUnits(labelerRewardUnits: bigint): bigint {
  return labelerRewardUnits + getPlatformFeeUnits();
}

export async function checkAndDebit(
  campaignId: string,
  labelerRewardUnits: bigint,
  submissionId: string,
): Promise<void> {
  const platformFeeUnits = getPlatformFeeUnits();
  const required = totalDebitUnits(labelerRewardUnits);

  await prisma.$transaction(async (tx) => {
    // Acquire a row-level lock on the campaign balance for the duration of the
    // transaction. Under READ COMMITTED two concurrent submissions for the same
    // campaign could otherwise both read the same balance, both pass the check,
    // and both debit (TOCTOU / overselling). FOR UPDATE serializes them.
    const locked = await tx.$queryRaw<{ balanceUnits: bigint }[]>`
      SELECT "balanceUnits" FROM "campaign_balances"
      WHERE "campaignId" = ${campaignId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.balanceUnits ?? 0n;

    if (currentBalance < required) {
      throw new InsufficientBalanceError(currentBalance, required);
    }

    await tx.campaignBalance.update({
      where: { campaignId },
      data: { balanceUnits: { decrement: required } },
    });

    await tx.balanceLedger.createMany({
      data: [
        { campaignId, type: "DEBIT_REWARD", amountUnits: labelerRewardUnits, submissionId },
        { campaignId, type: "DEBIT_FEE", amountUnits: platformFeeUnits, submissionId },
      ],
    });
  });
}

export async function creditBalance(
  campaignId: string,
  amountUnits: bigint,
  note?: string,
  type: "DEPOSIT" | "REFUND" = "DEPOSIT",
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.campaignBalance.upsert({
      where: { campaignId },
      create: { campaignId, balanceUnits: amountUnits },
      update: { balanceUnits: { increment: amountUnits } },
    });

    // Query the updated row explicitly — upsert may return the pre-increment value in some Prisma versions
    const updated = await tx.campaignBalance.findUnique({
      where: { campaignId },
      select: { balanceUnits: true },
    });

    await tx.balanceLedger.create({
      data: { campaignId, type, amountUnits, note: note ?? null },
    });

    return updated!.balanceUnits;
  });

  return result;
}

export async function getBalanceSummary(
  campaignId: string,
  campaignRewardUnits: bigint,
): Promise<{ balanceUnits: bigint; estimatedSubmissionsRemaining: number | null }> {
  const balance = await prisma.campaignBalance.findUnique({
    where: { campaignId },
    select: { balanceUnits: true },
  });

  const balanceUnits = balance?.balanceUnits ?? 0n;

  let estimatedSubmissionsRemaining: number | null = null;
  try {
    const platformFeeUnits = getPlatformFeeUnits();
    const costPerSubmission = campaignRewardUnits + platformFeeUnits;
    if (costPerSubmission > 0n) {
      estimatedSubmissionsRemaining = Number(balanceUnits / costPerSubmission);
    }
  } catch {
    // PLATFORM_FEE_UNITS not configured — estimate unavailable
  }

  return { balanceUnits, estimatedSubmissionsRemaining };
}
