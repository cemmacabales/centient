import { beforeEach, describe, expect, it } from "vitest";
import { readBroadcastVolumeSince, readLedgerPayout } from "@/lib/stellar/cosigner-ledger";
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
      openAttemptHash: null,
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
      openAttemptHash: null,
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

  it("carries a submission's open envelope through, and only an open one (#38)", async () => {
    const submission = await seedPendingSubmission();
    const expiresAt = new Date(Date.now() + 180_000);
    await prisma.payoutAttempt.create({
      data: { submissionId: submission.id, envelopeHash: "a".repeat(64), expiresAt, status: "void" },
    });
    expect((await readLedgerPayout(prisma, { kind: "submission", id: submission.id }))?.openAttemptHash).toBeNull();

    await prisma.payoutAttempt.create({ data: { submissionId: submission.id, envelopeHash: "b".repeat(64), expiresAt } });

    const row = await readLedgerPayout(prisma, { kind: "submission", id: submission.id });
    expect(row?.openAttemptHash).toBe("b".repeat(64));
  });

  it("reads a submission and its open envelope in one statement, so one snapshot (#38 review)", async () => {
    // Two reads could straddle a payer recording its payment: a stale
    // "pending, no hash" row next to a freshly "confirmed" envelope reads as
    // unpaid with nothing in flight, and the co-signer would sign again.
    const submission = await seedPendingSubmission();
    await prisma.payoutAttempt.create({
      data: { submissionId: submission.id, envelopeHash: "c".repeat(64), expiresAt: new Date(Date.now() + 180_000) },
    });
    const statements: string[] = [];
    const counting = {
      $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(query.join("?"));
        return prisma.$queryRaw<T>(query, ...values);
      },
      payoutJob: prisma.payoutJob,
    };

    const row = await readLedgerPayout(counting, { kind: "submission", id: submission.id });

    expect(statements).toHaveLength(1);
    expect(row).toMatchObject({ status: "pending", txHash: null, openAttemptHash: "c".repeat(64) });
  });

  it("returns null for a reference the ledger has no row for", async () => {
    const row = await readLedgerPayout(prisma, {
      kind: "submission",
      id: "00000000-0000-0000-0000-000000000000",
    });

    expect(row).toBeNull();
  });
});

describe("readBroadcastVolumeSince", () => {
  it("sums every job that reached the network, whatever became of it afterwards", async () => {
    // A hash is written only once Horizon accepted the payment, so the funds are
    // gone even for a job later quarantined as failed. The co-signer's cap has to
    // count that spend or it authorises more than the wallet actually has left.
    const since = new Date("2026-09-08T00:00:00.000Z");
    await prisma.payoutJob.createMany({
      data: [
        {
          type: "WITHDRAWAL",
          status: "done",
          amountUnits: 100_000_000n,
          txHash: "settled",
          broadcastAt: new Date("2026-09-08T01:00:00.000Z"),
        },
        {
          type: "WITHDRAWAL",
          status: "failed",
          amountUnits: 50_000_000n,
          txHash: "quarantined",
          broadcastAt: new Date("2026-09-08T02:00:00.000Z"),
        },
      ],
    });

    expect(await readBroadcastVolumeSince(prisma, since)).toBe(150_000_000n);
  });

  it("ignores jobs that never broadcast and jobs from before the window", async () => {
    const since = new Date("2026-09-08T00:00:00.000Z");
    await prisma.payoutJob.createMany({
      data: [
        { type: "WITHDRAWAL", status: "queued", amountUnits: 700_000_000n },
        {
          type: "WITHDRAWAL",
          status: "done",
          amountUnits: 900_000_000n,
          txHash: "yesterday",
          broadcastAt: new Date("2026-09-07T23:00:00.000Z"),
        },
      ],
    });

    expect(await readBroadcastVolumeSince(prisma, since)).toBe(0n);
  });
});
