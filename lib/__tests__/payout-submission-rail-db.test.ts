import { Keypair } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// #37 — an instant submission payout through the worker: spend against both
// daily caps, and nothing broadcast when the co-signer is missing or refuses.
//
// Submit queues a SUBMISSION_PAYOUT job with no amount: the amount lives on the
// submission row. Both caps sum `amountUnits` on jobs that carry a hash — the
// payout service's `getRolling24hPayoutSum` and the co-signer's independent
// `readBroadcastVolumeSince`. So a submission payout only counts if the worker
// writes the amount onto its job when it broadcasts. This runs the worker, the
// cap check, and both readers for real; only the Horizon submit is replaced.

const { mockSubmitMultisigPayout } = vi.hoisted(() => ({ mockSubmitMultisigPayout: vi.fn() }));
vi.mock("@/lib/stellar/payout-submitter", () => ({ submitMultisigPayout: mockSubmitMultisigPayout }));
vi.mock("@/lib/stellar/payout-cosigner", () => ({
  resolvePayoutCoSigner: vi.fn(() => ({ signPayout: vi.fn() })),
}));
vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { claimNextJob, processJob } from "@/lib/payout-worker";
import { resolvePayoutCoSigner } from "@/lib/stellar/payout-cosigner";
import { getRolling24hPayoutSum } from "@/lib/payout-cap";
import { readBroadcastVolumeSince } from "@/lib/stellar/cosigner-ledger";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, VALID_REASON } from "@/tests/helpers/factories";

const REWARD = 2_500_000n;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  let n = 0;
  mockSubmitMultisigPayout.mockImplementation(async () => ({ hash: `hash-${++n}` }));
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Exactly what submit writes for an accepted answer: a pending row and an amount-less job. */
async function enqueueAsSubmitDoes() {
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: null });
  const submission = await prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: REWARD,
      payoutStatus: "pending",
    },
  });
  await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: submission.id } });
  return submission;
}

async function workerTick() {
  const claimed = await claimNextJob();
  if (!claimed) throw new Error("nothing to claim");
  await processJob(claimed.id, claimed.submissionId, claimed.userId, claimed.amountUnits, claimed.type);
}

describe("instant submission payouts and the daily caps (#37)", () => {
  it("counts a broadcast submission payout toward both the platform and the co-signer cap", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "0";
    const since = new Date(Date.now() - 60_000);
    await enqueueAsSubmitDoes();

    await workerTick();

    const job = await prisma.payoutJob.findFirstOrThrow();
    expect(job).toMatchObject({ status: "done", amountUnits: REWARD });
    expect(job.txHash).toBeTruthy();
    expect(await getRolling24hPayoutSum()).toBe(REWARD);
    expect(await readBroadcastVolumeSince(prisma, since)).toBe(REWARD);
  });

  it("defers the next submission payout once the platform cap is spent, leaving it payable", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = String(REWARD);
    await enqueueAsSubmitDoes();
    await workerTick();
    const second = await enqueueAsSubmitDoes();

    await workerTick();

    expect(mockSubmitMultisigPayout).toHaveBeenCalledTimes(1);
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.payoutStatus).toBe("pending");
    expect(row.payoutTxHash).toBeNull();
    const job = await prisma.payoutJob.findUniqueOrThrow({ where: { submissionId: second.id } });
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("payout cap exceeded");
  });
});

describe("an unavailable or refusing co-signer (#37)", () => {
  /** Nothing left the wallet, and the row is still payable by the next attempt. */
  async function expectStillPayable(submissionId: string) {
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(row.payoutStatus).toBe("pending");
    expect(row.payoutTxHash).toBeNull();
    // The claim was handed back, so the requeued job can take it again.
    expect(row.lastRetriedAt).toBeNull();
    const job = await prisma.payoutJob.findUniqueOrThrow({ where: { submissionId } });
    expect(job.status).toBe("queued");
    expect(job.txHash).toBeNull();
    expect(job.retryCount).toBe(1);
    return job;
  }

  it("broadcasts nothing when the co-signer cannot be resolved", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "0";
    vi.mocked(resolvePayoutCoSigner).mockImplementationOnce(() => {
      throw new Error("COSIGNER_SHARED_SECRET must be set");
    });
    const submission = await enqueueAsSubmitDoes();

    await workerTick();

    expect(mockSubmitMultisigPayout).not.toHaveBeenCalled();
    const job = await expectStillPayable(submission.id);
    expect(job.lastError).toContain("COSIGNER_SHARED_SECRET");
  });

  it("records a co-signer refusal and leaves the row payable", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "0";
    mockSubmitMultisigPayout.mockRejectedValueOnce(new Error("payout co-signer refused: ledger disagrees"));
    const submission = await enqueueAsSubmitDoes();

    await workerTick();

    const job = await expectStillPayable(submission.id);
    expect(job.lastError).toContain("co-signer refused");
    expect(await getRolling24hPayoutSum()).toBe(0n);
  });
});
