import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";

// #38 — "one live envelope per submission" is a database rule.
//
// Every payer settles an open attempt before building another, and the co-signer
// refuses while one exists. The partial unique index is the floor under both: a
// second `open` attempt for a submission is refused even if the code above it
// gets that wrong.
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function submission() {
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: null });
  return prisma.submission.create({
    data: {
      userId: user.id,
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: 2_500_000n,
      payoutStatus: "pending",
    },
  });
}

const expiresAt = () => new Date(Date.now() + 180_000);

describe("payout_attempts (#38)", () => {
  it("refuses a second open attempt for the same submission", async () => {
    const sub = await submission();
    await prisma.payoutAttempt.create({ data: { submissionId: sub.id, envelopeHash: "a".repeat(64), expiresAt: expiresAt() } });

    await expect(
      prisma.payoutAttempt.create({ data: { submissionId: sub.id, envelopeHash: "b".repeat(64), expiresAt: expiresAt() } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows a new open attempt once the previous one is settled", async () => {
    const sub = await submission();
    await prisma.payoutAttempt.create({
      data: { submissionId: sub.id, envelopeHash: "a".repeat(64), expiresAt: expiresAt(), status: "void" },
    });

    await prisma.payoutAttempt.create({ data: { submissionId: sub.id, envelopeHash: "b".repeat(64), expiresAt: expiresAt() } });

    expect(await prisma.payoutAttempt.count({ where: { submissionId: sub.id } })).toBe(2);
  });

  it("allows open attempts for different submissions at once", async () => {
    const [a, b] = [await submission(), await submission()];
    await prisma.payoutAttempt.create({ data: { submissionId: a.id, envelopeHash: "a".repeat(64), expiresAt: expiresAt() } });
    await prisma.payoutAttempt.create({ data: { submissionId: b.id, envelopeHash: "b".repeat(64), expiresAt: expiresAt() } });
    expect(await prisma.payoutAttempt.count({ where: { status: "open" } })).toBe(2);
  });

  it("never records one envelope twice", async () => {
    const [a, b] = [await submission(), await submission()];
    await prisma.payoutAttempt.create({ data: { submissionId: a.id, envelopeHash: "a".repeat(64), expiresAt: expiresAt(), status: "void" } });
    await expect(
      prisma.payoutAttempt.create({ data: { submissionId: b.id, envelopeHash: "a".repeat(64), expiresAt: expiresAt() } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
