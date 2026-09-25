import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";

export class InsufficientUserBalanceError extends Error {
  constructor(
    public readonly balanceUnits: bigint,
    public readonly requiredUnits: bigint,
  ) {
    super(`User pending balance insufficient: have ${balanceUnits}, need ${requiredUnits}`);
    this.name = "InsufficientUserBalanceError";
  }
}

export class NoBalanceToWithdrawError extends Error {
  constructor(public readonly balanceUnits: bigint) {
    super(`Nothing to withdraw: balance ${balanceUnits}`);
    this.name = "NoBalanceToWithdrawError";
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
  amountUnits: bigint;
  newBalanceUnits: bigint;
}

export async function debitForWithdrawal(
  userId: string,
  amountUnits: bigint,
  payoutJobId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ pendingBalanceUnits: bigint }[]>`
      SELECT "pendingBalanceUnits" FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;

    const currentBalance = locked[0]?.pendingBalanceUnits ?? 0n;

    if (currentBalance < amountUnits) {
      throw new InsufficientUserBalanceError(currentBalance, amountUnits);
    }

    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceUnits: { decrement: amountUnits } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceUnits: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "WITHDRAWAL",
        amountUnits,
        submissionId: payoutJobId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceUnits;
  });

  return result;
}

/**
 * Restore a withdrawal's debit to the user's withdrawable balance.
 *
 * At most once per payout job (F1). The reversal is the one write in the
 * withdrawal rail that *creates* withdrawable balance, so a second one for the
 * same job is money the platform never debited, and a later withdrawal pays it
 * out for real. Two things could produce that second one: two reconcilers
 * reaching the same job's terminal path, and a caller replaying after a commit
 * whose response was lost.
 *
 * Both are closed the same way. The user row is locked `FOR UPDATE` first, which
 * serializes every reversal for this user, and under that lock a `REVERSAL`
 * ledger row already carrying this `payoutJobId` means the restoration has
 * happened — so this returns the balance unchanged instead of adding to it. The
 * lock is what makes the check sound: without it both callers would read "no
 * row" before either wrote one.
 *
 * A reversal with no `payoutJobId` cannot be keyed and is applied as asked; no
 * caller in the withdrawal rail omits it.
 */
export async function refundReversal(
  userId: string,
  amountUnits: bigint,
  payoutJobId?: string,
  note?: string,
): Promise<bigint> {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ pendingBalanceUnits: bigint }[]>`
      SELECT "pendingBalanceUnits" FROM "users"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;

    if (payoutJobId) {
      const already = await tx.userBalanceLedger.findFirst({
        where: { userId, type: "REVERSAL", submissionId: payoutJobId },
        select: { id: true },
      });
      if (already) {
        console.warn(
          `[user-balance] withdrawal ${payoutJobId} was already reversed — not restoring it a second time`,
        );
        return locked[0]?.pendingBalanceUnits ?? 0n;
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: { pendingBalanceUnits: { increment: amountUnits } },
    });

    const updated = await tx.user.findUnique({
      where: { id: userId },
      select: { pendingBalanceUnits: true },
    });

    await tx.userBalanceLedger.create({
      data: {
        userId,
        type: "REVERSAL",
        amountUnits,
        submissionId: payoutJobId ?? null,
        note: note ?? null,
      },
    });

    return updated!.pendingBalanceUnits;
  });

  return result;
}

/**
 * Atomically converts a user's full legacy balance into a single queued lump-sum
 * `PayoutJob` (the "one payout" of the withdrawal flow).
 *
 * #39: nothing accrues any more, so every balance this sees predates instant
 * payout, and it is withdrawn whatever its size — the old minimum would have
 * stranded most of them (ADR-0007).
 *
 * The whole thing runs in one transaction: the user row is locked `FOR UPDATE`,
 * the balance is checked to be non-zero, decremented, a `WITHDRAWAL` ledger
 * row is written, and the `PayoutJob` is created. Because it is one transaction,
 * a failure at any step (including the one-in-flight unique index) rolls back the
 * decrement, so funds can never be debited without a job to pay them out.
 *
 * Concurrency: the `FOR UPDATE` lock serializes competing requests for the same
 * user, and a partial unique index (`payout_jobs_user_inflight_withdrawal_key`)
 * guarantees at most one queued/processing withdrawal per user — together these
 * make double-spend impossible.
 *
 * @throws {NoBalanceToWithdrawError} the balance is zero.
 * @throws {WithdrawalInFlightError} the user already has a withdrawal in flight.
 */
export async function enqueueWithdrawal(
  userId: string,
  destinationAddress: string,
): Promise<WithdrawalResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ pendingBalanceUnits: bigint }[]>`
        SELECT "pendingBalanceUnits" FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;

      const balance = locked[0]?.pendingBalanceUnits ?? 0n;

      if (balance <= 0n) {
        throw new NoBalanceToWithdrawError(balance);
      }

      // Withdraw the entire accumulated balance as one lump sum.
      const amountUnits = balance;

      await tx.user.update({
        where: { id: userId },
        data: { pendingBalanceUnits: { decrement: amountUnits } },
      });

      const job = await tx.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId,
          amountUnits,
          destinationAddress,
          status: "queued",
        },
      });

      await tx.userBalanceLedger.create({
        data: {
          userId,
          type: "WITHDRAWAL",
          amountUnits,
          // `submissionId` is a reference to a Submission, not a PayoutJob, so it
          // stays null for withdrawals. The created job is identified by `type`
          // + `note` here and returned to the caller as `WithdrawalResult.payoutJobId`.
          submissionId: null,
          note: "withdrawal",
        },
      });

      return { payoutJobId: job.id, amountUnits, newBalanceUnits: balance - amountUnits };
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
    select: { pendingBalanceUnits: true },
  });
  return user?.pendingBalanceUnits ?? 0n;
}
