import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";

// #38 review — an envelope is journalled only while its submission is payable.
//
// The one-open index stops two envelopes being live at once, but not one being
// opened after another has already paid: a payer that got its signatures early
// could open its envelope the moment the first one is confirmed. `open` locks
// the submission row and refuses unless it is still payable, so it serializes
// with the write that records a payment and sees it.
import { submissionAttemptJournal, confirmAttempt } from "@/lib/payout-attempts";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function submission(data: { payoutStatus?: string; payoutTxHash?: string | null } = {}) {
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
      payoutStatus: data.payoutStatus ?? "pending",
      payoutTxHash: data.payoutTxHash ?? null,
    },
  });
}

const envelope = (hash: string) => ({ hash, expiresAt: new Date(Date.now() + 180_000) });

describe("submissionAttemptJournal.open (#38 review)", () => {
  it.each(["pending", "failed"])("opens an attempt for a %s submission with no hash", async (payoutStatus) => {
    const sub = await submission({ payoutStatus });
    await submissionAttemptJournal(sub.id).open(envelope("a".repeat(64)));
    expect(await prisma.payoutAttempt.count({ where: { submissionId: sub.id, status: "open" } })).toBe(1);
  });

  it.each([
    ["already carries a hash", { payoutStatus: "failed", payoutTxHash: "paid" }],
    ["is sent", { payoutStatus: "sent", payoutTxHash: "paid" }],
    ["is skipped", { payoutStatus: "skipped" }],
    ["is abandoned", { payoutStatus: "abandoned" }],
  ] as const)("refuses when the submission %s", async (_label, data) => {
    const sub = await submission(data);
    await expect(submissionAttemptJournal(sub.id).open(envelope("a".repeat(64)))).rejects.toThrow(/not payable/);
    expect(await prisma.payoutAttempt.count()).toBe(0);
  });

  it("waits for a payment being recorded, then refuses the late envelope", async () => {
    const sub = await submission();
    await prisma.payoutAttempt.create({
      data: { submissionId: sub.id, envelopeHash: "a".repeat(64), expiresAt: new Date(Date.now() + 180_000) },
    });

    // Payer A records its payment: hash on the row and its attempt confirmed,
    // in one transaction held open while payer B tries to open a second envelope.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let aHoldsRow!: () => void;
    const rowLocked = new Promise<void>((r) => (aHoldsRow = r));
    const payerA = prisma.$transaction(async (tx) => {
      await tx.submission.update({ where: { id: sub.id }, data: { payoutStatus: "sent", payoutTxHash: "a".repeat(64) } });
      await confirmAttempt("a".repeat(64), tx);
      aHoldsRow();
      await held;
    });
    await rowLocked;

    const payerB = submissionAttemptJournal(sub.id).open(envelope("b".repeat(64)));
    const settledEarly = await Promise.race([payerB.then(() => "opened", () => "refused"), new Promise((r) => setTimeout(() => r("waiting"), 100))]);
    expect(settledEarly).toBe("waiting");

    release();
    await payerA;
    await expect(payerB).rejects.toThrow(/not payable/);
    expect(await prisma.payoutAttempt.count({ where: { envelopeHash: "b".repeat(64) } })).toBe(0);
  });
});
