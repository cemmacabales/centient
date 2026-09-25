import prisma from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

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

/**
 * Debit a campaign the labeler reward plus the platform fee for one submission,
 * or throw {@link InsufficientBalanceError} having debited nothing.
 *
 * Pass `tx` to debit inside the caller's transaction, so the debit commits or
 * rolls back with the row it pays for (#36: the submit route writes the rewarded
 * submission in the same transaction). Without it the debit is its own.
 */
export async function checkAndDebit(
  campaignId: string,
  labelerRewardUnits: bigint,
  submissionId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const platformFeeUnits = getPlatformFeeUnits();
  const required = totalDebitUnits(labelerRewardUnits);

  const debit = async (client: Prisma.TransactionClient) => {
    // Acquire a row-level lock on the campaign balance for the duration of the
    // transaction. Under READ COMMITTED two concurrent submissions for the same
    // campaign could otherwise both read the same balance, both pass the check,
    // and both debit (TOCTOU / overselling). FOR UPDATE serializes them.
    const locked = await client.$queryRaw<{ balanceUnits: bigint }[]>`
      SELECT "balanceUnits" FROM "campaign_balances"
      WHERE "campaignId" = ${campaignId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.balanceUnits ?? 0n;

    if (currentBalance < required) {
      throw new InsufficientBalanceError(currentBalance, required);
    }

    await client.campaignBalance.update({
      where: { campaignId },
      data: { balanceUnits: { decrement: required } },
    });

    await client.balanceLedger.createMany({
      data: [
        { campaignId, type: "DEBIT_REWARD", amountUnits: labelerRewardUnits, submissionId },
        { campaignId, type: "DEBIT_FEE", amountUnits: platformFeeUnits, submissionId },
      ],
    });
  };

  if (tx) await debit(tx);
  else await prisma.$transaction(debit);
}

type LedgerClient = Pick<Prisma.TransactionClient, "balanceLedger">;

/**
 * Has this submission's campaign debit already been refunded? Refunds carry the
 * submission id since #37. Earlier ones name it only in their note (`… for
 * submission <id>`), so that is matched too: a refunded row must read as
 * refunded whichever era wrote the refund.
 */
export async function hasRefundedSubmission(
  client: LedgerClient,
  submissionId: string,
): Promise<boolean> {
  const refund = await client.balanceLedger.findFirst({
    where: {
      type: "REFUND",
      OR: [{ submissionId }, { note: { endsWith: `for submission ${submissionId}` } }],
    },
    select: { id: true },
  });
  return refund !== null;
}

/**
 * Credit a campaign's balance and record it in the ledger.
 *
 * A `REFUND` that names a `submissionId` is applied at most once per
 * submission: under a lock on the campaign's balance row, a submission already
 * refunded is left alone and the balance returned unchanged. Two payers that
 * both give up on the same payout therefore return its debit once (#37).
 */
export async function creditBalance(
  campaignId: string,
  amountUnits: bigint,
  note?: string,
  type: "DEPOSIT" | "REFUND" = "DEPOSIT",
  submissionId?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    if (type === "REFUND" && submissionId) {
      await tx.$executeRaw`SELECT 1 FROM "campaign_balances" WHERE "campaignId" = ${campaignId} FOR UPDATE`;
      if (await hasRefundedSubmission(tx, submissionId)) {
        const current = await tx.campaignBalance.findUnique({
          where: { campaignId },
          select: { balanceUnits: true },
        });
        return current?.balanceUnits ?? 0n;
      }
    }

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
      data: { campaignId, type, amountUnits, note: note ?? null, submissionId: submissionId ?? null },
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
