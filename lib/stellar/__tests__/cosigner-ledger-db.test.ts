import { beforeEach, describe, expect, it } from "vitest";
import { readLedgerPayout } from "@/lib/stellar/cosigner-ledger";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createTask, createUser } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

/** One pending, wallet-linked submission reward — the ordinary payable case. */
async function seedPendingSubmission(amountUnits = 25_000_000n) {
  const user = await createUser();
  const task = await createTask();
  return prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: "a sufficiently detailed reason for the choice",
      payoutAmountUnits: amountUnits,
      payoutStatus: "pending",
    },
  });
}

describe("readLedgerPayout", () => {
  it("projects a submission onto the ledger shape the policy check reads", async () => {
    const submission = await seedPendingSubmission();

    const row = await readLedgerPayout(prisma, { kind: "submission", id: submission.id });

    expect(row).toEqual({
      kind: "submission",
      id: submission.id,
      status: "pending",
      txHash: null,
      destination: submission.walletAddress,
      amountUnits: 25_000_000n,
    });
  });

  it("projects a payout job onto the same shape, using its own destination column", async () => {
    const user = await createUser();
    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountUnits: 500_000_000n,
        destinationAddress: user.walletAddress,
        status: "queued",
      },
    });

    const row = await readLedgerPayout(prisma, { kind: "payout_job", id: job.id });

    expect(row).toEqual({
      kind: "payout_job",
      id: job.id,
      status: "queued",
      txHash: null,
      destination: user.walletAddress,
      amountUnits: 500_000_000n,
    });
  });

  it("carries the broadcast hash through, so an already-paid row can be refused", async () => {
    const submission = await seedPendingSubmission();
    await prisma.submission.update({
      where: { id: submission.id },
      data: { payoutStatus: "sent", payoutTxHash: "already-broadcast" },
    });

    const row = await readLedgerPayout(prisma, { kind: "submission", id: submission.id });

    expect(row?.txHash).toBe("already-broadcast");
    expect(row?.status).toBe("sent");
  });

  it("returns null for a reference the ledger has no row for", async () => {
    const row = await readLedgerPayout(prisma, {
      kind: "submission",
      id: "00000000-0000-0000-0000-000000000000",
    });

    expect(row).toBeNull();
  });
});
