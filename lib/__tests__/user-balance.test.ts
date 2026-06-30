import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createUserBalance } from "@/tests/helpers/factories";
import {
  creditReward,
  debitForWithdrawal,
  refundReversal,
  getUserPendingBalance,
  enqueueWithdrawal,
  InsufficientUserBalanceError,
  BelowMinimumWithdrawalError,
  WithdrawalInFlightError,
} from "@/lib/user-balance";

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  await truncateAll();
});

describe("creditReward", () => {
  it("increments pendingBalanceStroops and creates CREDIT_REWARD ledger entry", async () => {
    const user = await createUser({ pendingBalanceStroops: 0n });

    const newBalance = await creditReward(user.id, 1000000000000000000n, "sub-001", "first reward");

    expect(newBalance).toBe(1000000000000000000n);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(1000000000000000000n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("CREDIT_REWARD");
    expect(ledger[0].amountStroops).toBe(1000000000000000000n);
    expect(ledger[0].submissionId).toBe("sub-001");
    expect(ledger[0].note).toBe("first reward");
  });

  it("accumulates on subsequent credits", async () => {
    const user = await createUser({ pendingBalanceStroops: 500000000000000000n });

    const newBalance = await creditReward(user.id, 500000000000000000n);

    expect(newBalance).toBe(1000000000000000000n);
  });

  it("creates ledger entry without submissionId when omitted", async () => {
    const user = await createUser();

    await creditReward(user.id, 100n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger[0].submissionId).toBeNull();
    expect(ledger[0].note).toBeNull();
  });

  it("works on user with no prior balance record", async () => {
    const user = await createUser({ pendingBalanceStroops: 0n });

    const newBalance = await creditReward(user.id, 250000000000000000n);

    expect(newBalance).toBe(250000000000000000n);
  });
});

describe("debitForWithdrawal", () => {
  it("decrements pendingBalanceStroops and creates WITHDRAWAL ledger entry", async () => {
    const user = await createUser({ pendingBalanceStroops: 1000000000000000000n });

    const newBalance = await debitForWithdrawal(user.id, 300000000000000000n, "payout-001", "withdrawal");

    expect(newBalance).toBe(700000000000000000n);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(700000000000000000n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("WITHDRAWAL");
    expect(ledger[0].amountStroops).toBe(300000000000000000n);
    expect(ledger[0].submissionId).toBe("payout-001");
    expect(ledger[0].note).toBe("withdrawal");
  });

  it("throws InsufficientUserBalanceError when balance is too low", async () => {
    const user = await createUser({ pendingBalanceStroops: 100000000000000000n });

    await expect(
      debitForWithdrawal(user.id, 500000000000000000n, "payout-002")
    ).rejects.toThrow(InsufficientUserBalanceError);
  });

  it("throws InsufficientUserBalanceError when user has no pending balance", async () => {
    const user = await createUser({ pendingBalanceStroops: 0n });

    await expect(
      debitForWithdrawal(user.id, 100000000000000000n, "payout-003")
    ).rejects.toThrow(InsufficientUserBalanceError);
  });

  it("succeeds when balance exactly equals withdrawal amount", async () => {
    const user = await createUser({ pendingBalanceStroops: 500000000000000000n });

    await expect(
      debitForWithdrawal(user.id, 500000000000000000n, "payout-004")
    ).resolves.toBe(0n);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(0n);
  });

  it("creates ledger entry without payoutJobId when omitted", async () => {
    const user = await createUser({ pendingBalanceStroops: 1000000000000000000n });

    await debitForWithdrawal(user.id, 100000000000000000n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger[0].submissionId).toBeNull();
    expect(ledger[0].note).toBeNull();
  });
});

describe("refundReversal", () => {
  it("increments pendingBalanceStroops and creates REVERSAL ledger entry", async () => {
    const user = await createUser({ pendingBalanceStroops: 500000000000000000n });

    const newBalance = await refundReversal(user.id, 300000000000000000n, "payout-001", "failed payout");

    expect(newBalance).toBe(800000000000000000n);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(800000000000000000n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("REVERSAL");
    expect(ledger[0].amountStroops).toBe(300000000000000000n);
    expect(ledger[0].submissionId).toBe("payout-001");
    expect(ledger[0].note).toBe("failed payout");
  });

  it("accumulates on multiple reversals", async () => {
    const user = await createUser({ pendingBalanceStroops: 500000000000000000n });

    await refundReversal(user.id, 100000000000000000n, "payout-001");
    const newBalance = await refundReversal(user.id, 100000000000000000n, "payout-002");

    expect(newBalance).toBe(700000000000000000n);
  });

  it("creates ledger entry without payoutJobId when omitted", async () => {
    const user = await createUser();

    await refundReversal(user.id, 100n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger[0].submissionId).toBeNull();
    expect(ledger[0].note).toBeNull();
  });
});

describe("getUserPendingBalance", () => {
  it("returns pendingBalanceStroops for user", async () => {
    const user = await createUser({ pendingBalanceStroops: 750000000000000000n });

    const balance = await getUserPendingBalance(user.id);

    expect(balance).toBe(750000000000000000n);
  });

  it("returns 0n when user has no balance record", async () => {
    const balance = await getUserPendingBalance("non-existent-user-id");

    expect(balance).toBe(0n);
  });
});

describe("ledger completeness", () => {
  it("balance and ledger always reconcile after credit + debit", async () => {
    const user = await createUser({ pendingBalanceStroops: 1000000000000000000n });

    await creditReward(user.id, 500000000000000000n, "sub-001");
    await debitForWithdrawal(user.id, 300000000000000000n, "payout-001");
    await refundReversal(user.id, 100000000000000000n, "payout-002", "refund");

    const balance = await getUserPendingBalance(user.id);
    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });

    const netChange = ledger.reduce((sum, entry) => {
      if (entry.type === "CREDIT_REWARD" || entry.type === "REVERSAL") {
        return sum + entry.amountStroops;
      }
      return sum - entry.amountStroops;
    }, 0n);

    const initialBalance = 1000000000000000000n;
    expect(balance).toBe(initialBalance + netChange);
    expect(ledger).toHaveLength(3);
  });

  it("all mutations produce matching ledger rows", async () => {
    const user = await createUser({ pendingBalanceStroops: 0n });

    await creditReward(user.id, 500000000000000000n, "sub-001");
    await debitForWithdrawal(user.id, 200000000000000000n, "payout-001");
    await refundReversal(user.id, 50000000000000000n, "payout-002");

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });

    expect(ledger).toHaveLength(3);
    expect(ledger.every(l => l.amountStroops > 0n)).toBe(true);
    expect(ledger.map(l => l.type).sort()).toEqual(["CREDIT_REWARD", "REVERSAL", "WITHDRAWAL"]);
  });
});

describe("enqueueWithdrawal", () => {
  const DEST = "0x000000000000000000000000000000000000dEaD";
  const MIN = 1000000000000000000n; // 1 token

  it("creates a single WITHDRAWAL PayoutJob for the full balance and zeroes it", async () => {
    const user = await createUser({ pendingBalanceStroops: 5000000000000000000n });

    const result = await enqueueWithdrawal(user.id, DEST, MIN);

    expect(result.amountStroops).toBe(5000000000000000000n);
    expect(result.newBalanceStroops).toBe(0n);
    expect(result.payoutJobId).toBeTruthy();

    const jobs = await prisma.payoutJob.findMany({ where: { userId: user.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("WITHDRAWAL");
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].submissionId).toBeNull();
    expect(jobs[0].amountStroops).toBe(5000000000000000000n);
    expect(jobs[0].destinationAddress).toBe(DEST);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(0n);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    const withdrawals = ledger.filter((l) => l.type === "WITHDRAWAL");
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0].amountStroops).toBe(5000000000000000000n);
  });

  it("throws BelowMinimumWithdrawalError and changes nothing when balance < minimum", async () => {
    const user = await createUser({ pendingBalanceStroops: 500000000000000000n });

    await expect(enqueueWithdrawal(user.id, DEST, MIN)).rejects.toThrow(
      BelowMinimumWithdrawalError,
    );

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(500000000000000000n);
    expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.userBalanceLedger.count({ where: { userId: user.id } })).toBe(0);
  });

  it("throws BelowMinimumWithdrawalError when the balance is zero", async () => {
    const user = await createUser({ pendingBalanceStroops: 0n });

    await expect(enqueueWithdrawal(user.id, DEST, MIN)).rejects.toThrow(
      BelowMinimumWithdrawalError,
    );
  });

  it("succeeds when balance exactly equals the minimum", async () => {
    const user = await createUser({ pendingBalanceStroops: MIN });

    const result = await enqueueWithdrawal(user.id, DEST, MIN);

    expect(result.amountStroops).toBe(MIN);
    expect(result.newBalanceStroops).toBe(0n);
  });

  it("throws WithdrawalInFlightError when a withdrawal is already queued", async () => {
    const user = await createUser({ pendingBalanceStroops: 5000000000000000000n });
    await enqueueWithdrawal(user.id, DEST, MIN);

    // Top the balance back up so the second request passes the minimum check and
    // is only stopped by the one-in-flight guard.
    await createUserBalance(user.id, 5000000000000000000n);

    await expect(enqueueWithdrawal(user.id, DEST, MIN)).rejects.toThrow(
      WithdrawalInFlightError,
    );

    // The rolled-back second attempt must not touch the balance.
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(5000000000000000000n);
    expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(1);
  });

  it("serializes concurrent withdrawals into exactly one job (no double-spend)", async () => {
    const user = await createUser({ pendingBalanceStroops: 5000000000000000000n });

    const results = await Promise.allSettled([
      enqueueWithdrawal(user.id, DEST, MIN),
      enqueueWithdrawal(user.id, DEST, MIN),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const jobs = await prisma.payoutJob.findMany({ where: { userId: user.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].amountStroops).toBe(5000000000000000000n);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceStroops).toBe(0n);

    const withdrawals = await prisma.userBalanceLedger.findMany({
      where: { userId: user.id, type: "WITHDRAWAL" },
    });
    expect(withdrawals).toHaveLength(1);
  });
});

describe("concurrency safety", () => {
  it("concurrent credits are applied atomically without lost updates", async () => {
    const user = await createUser({ pendingBalanceStroops: 0n });

    const creditAmount = 100000000000000000n;
    const concurrentCredits = 10;

    await Promise.all(
      Array.from({ length: concurrentCredits }, (_, i) =>
        creditReward(user.id, creditAmount, `sub-${i}`)
      )
    );

    const balance = await getUserPendingBalance(user.id);
    expect(balance).toBe(creditAmount * BigInt(concurrentCredits));

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(concurrentCredits);
  });

  it("concurrent withdrawals are serialized and second one throws InsufficientUserBalanceError", async () => {
    const user = await createUser({ pendingBalanceStroops: 1000000000000000000n });

    const withdrawalAmount = 600000000000000000n;

    const results = await Promise.allSettled([
      debitForWithdrawal(user.id, withdrawalAmount, "payout-001"),
      debitForWithdrawal(user.id, withdrawalAmount, "payout-002"),
    ]);

    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InsufficientUserBalanceError);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    const withdrawals = ledger.filter(l => l.type === "WITHDRAWAL");

    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0].amountStroops).toBe(withdrawalAmount);

    const balance = await getUserPendingBalance(user.id);
    expect(balance).toBe(1000000000000000000n - withdrawalAmount);
  });
});
