import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";

export class InsufficientUserBalanceError extends Error {
  constructor(
    public readonly balanceWei: bigint,
    public readonly requiredWei: bigint,
  ) {
    super(`User pending balance insufficient: have ${balanceWei}, need ${requiredWei}`);
    this.name = "InsufficientUserBalanceError";
  }
}

export class BelowMinimumWithdrawalError extends Error {
  constructor(
    public readonly balanceWei: bigint,
    public readonly minimumWei: bigint,
  ) {
    super(`Withdrawal below minimum: balance ${balanceWei}, minimum ${minimumWei}`);
    this.name = "BelowMinimumWithdrawalError";
  }
}

export class WithdrawalInFlightError extends Error {
  constructor(public readonly userId: string) {
    super(`A withdrawal is already in flight for user ${userId}`);
    this.name = "WithdrawalInFlightError";
  }
}

export interface WithdrawalResult {
  payoutJobId: string;
  amountWei: bigint;
  newBalanceWei: bigint;
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

/**
 * Atomically converts a user's full accumulated balance into a single queued
 * lump-sum `PayoutJob` (the "one payout" of the withdrawal flow).
 *
 * The whole thing runs in one transaction: the user row is locked `FOR UPDATE`,
 * the balance is checked against `minimumWei`, decremented, a `WITHDRAWAL` ledger
 * row is written, and the `PayoutJob` is created. Because it is one transaction,
 * a failure at any step (including the one-in-flight unique index) rolls back the
 * decrement, so funds can never be debited without a job to pay them out.
 *
 * Concurrency: the `FOR UPDATE` lock serializes competing requests for the same
 * user, and a partial unique index (`payout_jobs_user_inflight_withdrawal_key`)
 * guarantees at most one queued/processing withdrawal per user — together these
 * make double-spend impossible.
 *
 * @throws {BelowMinimumWithdrawalError} balance is below `minimumWei` (or zero).
 * @throws {WithdrawalInFlightError} the user already has a withdrawal in flight.
 */
export async function enqueueWithdrawal(
  userId: string,
  destinationAddress: string,
  minimumWei: bigint,
): Promise<WithdrawalResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ pendingBalanceWei: bigint }[]>`
        SELECT "pendingBalanceWei" FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;

      const balance = locked[0]?.pendingBalanceWei ?? 0n;

      if (balance <= 0n || balance < minimumWei) {
        throw new BelowMinimumWithdrawalError(balance, minimumWei);
      }

      // Withdraw the entire accumulated balance as one lump sum.
      const amountWei = balance;

      await tx.user.update({
        where: { id: userId },
        data: { pendingBalanceWei: { decrement: amountWei } },
      });

      const job = await tx.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId,
          amountWei,
          destinationAddress,
          status: "queued",
        },
      });

      await tx.userBalanceLedger.create({
        data: {
          userId,
          type: "WITHDRAWAL",
          amountWei,
          submissionId: job.id,
          note: "withdrawal",
        },
      });

      return { payoutJobId: job.id, amountWei, newBalanceWei: balance - amountWei };
    });
  } catch (err) {
    // The partial unique index on (userId) WHERE type='WITHDRAWAL' AND status in
    // ('queued','processing') is the only unique constraint a withdrawal insert can
    // violate, so a P2002 here means a concurrent/duplicate withdrawal is in flight.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new WithdrawalInFlightError(userId);
    }
    throw err;
  }
}

export async function getUserPendingBalance(userId: string): Promise<bigint> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pendingBalanceWei: true },
  });
  return user?.pendingBalanceWei ?? 0n;
}
