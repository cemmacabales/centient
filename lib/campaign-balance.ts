import prisma from "@/lib/prisma";

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly balanceWei: bigint,
    public readonly requiredWei: bigint,
  ) {
    super(`Campaign balance insufficient: have ${balanceWei}, need ${requiredWei}`);
    this.name = "InsufficientBalanceError";
  }
}

export function getPlatformFeeWei(): bigint {
  const raw = process.env.PLATFORM_FEE_WEI;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("PLATFORM_FEE_WEI env var is required and must be a non-negative integer string");
  }
  return BigInt(raw);
}

// Single source of truth for the per-submission debit/refund amount so the
// labeler reward + platform fee is never computed inconsistently across the
// debit site (checkAndDebit) and the refund sites in the submit route.
export function totalDebitWei(labelerRewardWei: bigint): bigint {
  return labelerRewardWei + getPlatformFeeWei();
}

export async function checkAndDebit(
  campaignId: string,
  labelerRewardWei: bigint,
  submissionId: string,
): Promise<void> {
  const platformFeeWei = getPlatformFeeWei();
  const required = totalDebitWei(labelerRewardWei);

  await prisma.$transaction(async (tx) => {
    // Acquire a row-level lock on the campaign balance for the duration of the
    // transaction. Under READ COMMITTED two concurrent submissions for the same
    // campaign could otherwise both read the same balance, both pass the check,
    // and both debit (TOCTOU / overselling). FOR UPDATE serializes them.
    const locked = await tx.$queryRaw<{ balanceWei: bigint }[]>`
      SELECT "balanceWei" FROM "campaign_balances"
      WHERE "campaignId" = ${campaignId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.balanceWei ?? 0n;

    if (currentBalance < required) {
      throw new InsufficientBalanceError(currentBalance, required);
    }

    await tx.campaignBalance.update({
      where: { campaignId },
      data: { balanceWei: { decrement: required } },
    });

    await tx.balanceLedger.createMany({
      data: [
        { campaignId, type: "DEBIT_REWARD", amountWei: labelerRewardWei, submissionId },
        { campaignId, type: "DEBIT_FEE", amountWei: platformFeeWei, submissionId },
      ],
    });
  });
}

export async function creditBalance(
  campaignId: string,
  amountWei: bigint,
  note?: string,
  type: "DEPOSIT" | "REFUND" = "DEPOSIT",
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.campaignBalance.upsert({
      where: { campaignId },
      create: { campaignId, balanceWei: amountWei },
      update: { balanceWei: { increment: amountWei } },
    });

    // Query the updated row explicitly — upsert may return the pre-increment value in some Prisma versions
    const updated = await tx.campaignBalance.findUnique({
      where: { campaignId },
      select: { balanceWei: true },
    });

    await tx.balanceLedger.create({
      data: { campaignId, type, amountWei, note: note ?? null },
    });

    return updated!.balanceWei;
  });

  return result;
}

export async function getBalanceSummary(
  campaignId: string,
  campaignRewardWei: bigint,
): Promise<{ balanceWei: bigint; estimatedSubmissionsRemaining: number | null }> {
  const balance = await prisma.campaignBalance.findUnique({
    where: { campaignId },
    select: { balanceWei: true },
  });

  const balanceWei = balance?.balanceWei ?? 0n;

  let estimatedSubmissionsRemaining: number | null = null;
  try {
    const platformFeeWei = getPlatformFeeWei();
    const costPerSubmission = campaignRewardWei + platformFeeWei;
    if (costPerSubmission > 0n) {
      estimatedSubmissionsRemaining = Number(balanceWei / costPerSubmission);
    }
  } catch {
    // PLATFORM_FEE_WEI not configured — estimate unavailable
  }

  return { balanceWei, estimatedSubmissionsRemaining };
}
