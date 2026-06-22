import prisma from "@/lib/prisma";

export class InsufficientUserBalanceError extends Error {
  constructor(
    public readonly balanceWei: bigint,
    public readonly requiredWei: bigint,
  ) {
    super(`User pending balance insufficient: have ${balanceWei}, need ${requiredWei}`);
    this.name = "InsufficientUserBalanceError";
  }
}

export async function creditReward(
  userId: string,
  amountWei: bigint,
  submissionId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceWei: { increment: amountWei } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceWei: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "CREDIT_REWARD",
        amountWei,
        submissionId: submissionId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceWei;
  });

  return result;
}

export async function debitForWithdrawal(
  userId: string,
  amountWei: bigint,
  payoutJobId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ pendingBalanceWei: bigint }[]>`
      SELECT "pendingBalanceWei" FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.pendingBalanceWei ?? 0n;

    if (currentBalance < amountWei) {
      throw new InsufficientUserBalanceError(currentBalance, amountWei);
    }

    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceWei: { decrement: amountWei } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceWei: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "WITHDRAWAL",
        amountWei,
        submissionId: payoutJobId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceWei;
  });

  return result;
}

export async function refundReversal(
  userId: string,
  amountWei: bigint,
  payoutJobId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceWei: { increment: amountWei } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceWei: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "REVERSAL",
        amountWei,
        submissionId: payoutJobId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceWei;
  });

  return result;
}

export async function getUserPendingBalance(userId: string): Promise<bigint> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pendingBalanceWei: true },
  });
  return user?.pendingBalanceWei ?? 0n;
}
