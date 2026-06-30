import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";

export class InsufficientUserBalanceError extends Error {
  constructor(
    public readonly balanceStroops: bigint,
    public readonly requiredStroops: bigint,
  ) {
    super(`User pending balance insufficient: have ${balanceStroops}, need ${requiredStroops}`);
    this.name = "InsufficientUserBalanceError";
  }
}

export class BelowMinimumWithdrawalError extends Error {
  constructor(
    public readonly balanceStroops: bigint,
    public readonly minimumStroops: bigint,
  ) {
    super(`Withdrawal below minimum: balance ${balanceStroops}, minimum ${minimumStroops}`);
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
  amountStroops: bigint;
  newBalanceStroops: bigint;
}

export async function creditReward(
  userId: string,
  amountStroops: bigint,
  submissionId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceStroops: { increment: amountStroops } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceStroops: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "CREDIT_REWARD",
        amountStroops,
        submissionId: submissionId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceStroops;
  });

  return result;
}

export async function debitForWithdrawal(
  userId: string,
  amountStroops: bigint,
  payoutJobId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ pendingBalanceStroops: bigint }[]>`
      SELECT "pendingBalanceStroops" FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.pendingBalanceStroops ?? 0n;

    if (currentBalance < amountStroops) {
      throw new InsufficientUserBalanceError(currentBalance, amountStroops);
    }

    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceStroops: { decrement: amountStroops } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceStroops: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "WITHDRAWAL",
        amountStroops,
        submissionId: payoutJobId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceStroops;
  });

  return result;
}

export async function refundReversal(
  userId: string,
  amountStroops: bigint,
  payoutJobId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceStroops: { increment: amountStroops } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceStroops: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "REVERSAL",
        amountStroops,
        submissionId: payoutJobId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceStroops;
  });

  return result;
}

/**
 * Atomically converts a user's full accumulated balance into a single queued
 * lump-sum `PayoutJob` (the "one payout" of the withdrawal flow).
 *
 * The whole thing runs in one transaction: the user row is locked `FOR UPDATE`,
 * the balance is checked against `minimumStroops`, decremented, a `WITHDRAWAL` ledger
 * row is written, and the `PayoutJob` is created. Because it is one transaction,
 * a failure at any step (including the one-in-flight unique index) rolls back the
 * decrement, so funds can never be debited without a job to pay them out.
 *
 * Concurrency: the `FOR UPDATE` lock serializes competing requests for the same
 * user, and a partial unique index (`payout_jobs_user_inflight_withdrawal_key`)
 * guarantees at most one queued/processing withdrawal per user — together these
 * make double-spend impossible.
 *
 * @throws {BelowMinimumWithdrawalError} balance is below `minimumStroops` (or zero).
 * @throws {WithdrawalInFlightError} the user already has a withdrawal in flight.
 */
export async function enqueueWithdrawal(
  userId: string,
  destinationAddress: string,
  minimumStroops: bigint,
): Promise<WithdrawalResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ pendingBalanceStroops: bigint }[]>`
        SELECT "pendingBalanceStroops" FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;

      const balance = locked[0]?.pendingBalanceStroops ?? 0n;

      if (balance <= 0n || balance < minimumStroops) {
        throw new BelowMinimumWithdrawalError(balance, minimumStroops);
      }

      // Withdraw the entire accumulated balance as one lump sum.
      const amountStroops = balance;

      await tx.user.update({
        where: { id: userId },
        data: { pendingBalanceStroops: { decrement: amountStroops } },
      });

      const job = await tx.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId,
          amountStroops,
          destinationAddress,
          status: "queued",
        },
      });

      await tx.userBalanceLedger.create({
        data: {
          userId,
          type: "WITHDRAWAL",
          amountStroops,
          // `submissionId` is a reference to a Submission, not a PayoutJob, so it
          // stays null for withdrawals. The created job is identified by `type`
          // + `note` here and returned to the caller as `WithdrawalResult.payoutJobId`.
          submissionId: null,
          note: "withdrawal",
        },
      });

      return { payoutJobId: job.id, amountStroops, newBalanceStroops: balance - amountStroops };
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
    select: { pendingBalanceStroops: true },
  });
  return user?.pendingBalanceStroops ?? 0n;
}
