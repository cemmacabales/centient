import { vi, describe, it, expect, beforeEach } from "vitest";

// Payouts are async: the route debits the campaign balance up front and enqueues a
// PayoutJob; the worker performs the on-chain transfer. Permanent failures reverse
// that debit, while a transient daily-cap refusal leaves it reserved for retry.

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return { ...actual, payReward: vi.fn() };
});

vi.mock("@/lib/campaign-balance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/campaign-balance")>();
  return { ...actual, creditBalance: vi.fn() };
});

vi.mock("@/lib/stellar/balance", () => ({
  checkAndAlert: vi.fn(async () => {}),
}));

import { processJob } from "@/lib/payout-worker";
import { payReward, PayoutCapError } from "@/lib/payout";
import { StellarPaymentError } from "@/lib/stellar/client";
import { creditBalance } from "@/lib/campaign-balance";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, createCampaign, VALID_REASON } from "@/tests/helpers/factories";
import { SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";

// The worker only marks a job permanently failed once its retry budget is exhausted.
// Seeding retryCount one below MAX_RETRIES makes the next attempt terminal.
const RETRY_BUDGET_EXHAUSTED = 2;
const AMOUNT_UNITS = 50000000000000000n;
const TX_HASH = "payout-broadcast-hash";

// Two independent counters guard a submission payout. `PayoutJob.retryCount` is
// the worker's own budget, spent only while the job is still claimable. Once the
// job is terminal it is inert, and the counter that decides whether a deferred
// payout is ever retried is `Submission.retryCount`, which
// `/api/cron/payout-retry` checks against its own MAX_RETRIES.
async function enqueuePendingPayout(opts: {
  campaignId?: string | null;
  isGold?: boolean;
  retryCount?: number;
  submissionRetryCount?: number;
} = {}) {
  const user = await createUser();
  const task = await createTask({
    campaignId: opts.campaignId ?? null,
    isGold: opts.isGold ?? false,
  });
  const submission = await prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: AMOUNT_UNITS,
      payoutStatus: "pending",
      retryCount: opts.submissionRetryCount ?? 0,
    },
  });
  const job = await prisma.payoutJob.create({
    data: {
      type: "SUBMISSION_PAYOUT",           // ✅ required
      submissionId: submission.id,
      status: "processing",
      retryCount: opts.retryCount ?? 0,
    },
  });
  return { user, task, submission, job };
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(payReward).mockReset();
  vi.mocked(creditBalance).mockReset();
  vi.mocked(creditBalance).mockResolvedValue(0n);
  process.env.PLATFORM_FEE_UNITS = "1500000"; // 0.15 USDC in seven-decimal units
});

describe("payout-worker accepted submission payments", () => {
  it("records the accepted payment tuple on its payout job", async () => {
    vi.mocked(payReward).mockResolvedValueOnce(TX_HASH);
    const { submission, job, user } = await enqueuePendingPayout();

    const beforeBroadcast = new Date();
    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    const updatedJob = await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(updatedJob.txHash).toBe(TX_HASH);
    expect(updatedJob.amountUnits).toBe(AMOUNT_UNITS);
    expect(updatedJob.broadcastAt?.getTime()).toBeGreaterThanOrEqual(beforeBroadcast.getTime());
  });
});

describe("payout-worker instant submission payout (#37)", () => {
  it("credits earned totals only: an on-chain reward is never also withdrawable", async () => {
    vi.mocked(payReward).mockResolvedValueOnce(TX_HASH);
    const { submission, job, user } = await enqueuePendingPayout();

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    const paid = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(paid.payoutStatus).toBe("sent");
    expect(paid.payoutTxHash).toBe(TX_HASH);
    const settled = await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(settled.status).toBe("done");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totalEarnedUnits).toBe(user.totalEarnedUnits + AMOUNT_UNITS);
    expect(after.submissionCount).toBe(user.submissionCount + 1);
    expect(after.pendingBalanceUnits).toBe(user.pendingBalanceUnits);
    expect(await prisma.userBalanceLedger.count({ where: { userId: user.id } })).toBe(0);
  });

  it("stands down without broadcasting while another payer holds the submission's claim", async () => {
    const { submission, job, user } = await enqueuePendingPayout();
    // What `claimForRetry` leaves behind for a retry-cron or admin broadcast in flight.
    await prisma.submission.update({ where: { id: submission.id }, data: { lastRetriedAt: new Date() } });

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    expect(payReward).not.toHaveBeenCalled();
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(row.payoutStatus).toBe("pending");
    expect(row.payoutTxHash).toBeNull();
    const standDown = await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(standDown.status).toBe("failed");
    expect(standDown.lastError).toContain("another payer");
  });

  it("stands down on a submission that already carries a hash", async () => {
    const { submission, job, user } = await enqueuePendingPayout();
    await prisma.submission.update({ where: { id: submission.id }, data: { payoutTxHash: "already-broadcast" } });

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    expect(payReward).not.toHaveBeenCalled();
  });

  it("hands its claim back after a retryable failure, so its own requeued attempt can pay", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout")).mockResolvedValueOnce(TX_HASH);
    const { submission, job, user } = await enqueuePendingPayout();

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");
    const released = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(released.lastRetriedAt).toBeNull();
    expect((await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");

    await prisma.payoutJob.update({ where: { id: job.id }, data: { status: "processing" } });
    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    expect(payReward).toHaveBeenCalledTimes(2);
    const paid = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(paid.payoutStatus).toBe("sent");
  });

  it.each([
    ["retries exhausted", () => new Error("rpc timeout"), RETRY_BUDGET_EXHAUSTED],
    ["non-retryable", () => new StellarPaymentError("no USDC trustline", "op_no_trust", false), 0],
  ] as const)("a refunded %s payout exhausts the retry cron's budget too", async (_label, error, retryCount) => {
    // The cron offers `failed` rows under its own budget. A row the worker has
    // refunded must be out of it, or the cron pays it with no funding behind it.
    vi.mocked(payReward).mockRejectedValueOnce(error());
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({ campaignId: campaign.id, retryCount });

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    expect(creditBalance).toHaveBeenCalledOnce();
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(row.payoutStatus).toBe("failed");
    expect(row.retryCount).toBeGreaterThanOrEqual(SUBMISSION_RETRY_BUDGET);
  });
});

describe("payout-worker task resolution counts settled answers only (#37)", () => {
  /** A target-2 task holding one other answer in `otherStatus`, plus this one queued to pay. */
  async function secondAnswerOf(otherStatus: string, otherChoice: "A" | "B" = "B") {
    const task = await createTask({ campaignId: null, responseTarget: 2 });
    const other = await createUser();
    await prisma.submission.create({
      data: {
        walletAddress: other.walletAddress,
        userId: other.id,
        taskId: task.id,
        choice: otherChoice,
        reason: VALID_REASON,
        payoutAmountUnits: AMOUNT_UNITS,
        payoutStatus: otherStatus,
      },
    });
    const user = await createUser();
    const submission = await prisma.submission.create({
      data: {
        walletAddress: user.walletAddress,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: AMOUNT_UNITS,
        payoutStatus: "pending",
      },
    });
    const job = await prisma.payoutJob.create({
      data: { type: "SUBMISSION_PAYOUT", submissionId: submission.id, status: "processing" },
    });
    return { task, user, submission, job };
  }

  it("does not resolve a task on an answer whose payout is still in flight", async () => {
    // The in-flight answer may yet fail and be refunded; a resolved task is
    // never recomputed, so its choice must not be baked into the result.
    vi.mocked(payReward).mockResolvedValueOnce(TX_HASH);
    const { task, user, submission, job } = await secondAnswerOf("pending");

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.resolvedAt).toBeNull();
    expect(after.majorityAnswer).toBeNull();
  });

  it("resolves once the target is met by settled answers", async () => {
    vi.mocked(payReward).mockResolvedValueOnce(TX_HASH);
    const { task, user, submission, job } = await secondAnswerOf("sent", "A");

    await processJob(job.id, submission.id, user.id, AMOUNT_UNITS, "SUBMISSION_PAYOUT");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.resolvedAt).not.toBeNull();
    expect(after.majorityAnswer).toBe("A");
  });
});

describe("payout-worker campaign balance refunds", () => {
  it("leaves a cap-blocked submission pending without refunding or burning a retry", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new PayoutCapError(1n, 1n));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: 2,
      submissionRetryCount: 1,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    expect(creditBalance).not.toHaveBeenCalled();
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("pending");
    // The assertion that matters for recovery: `/api/cron/payout-retry` selects
    // pending submissions whose own retryCount is still under budget, so leaving
    // this untouched is what keeps the deferred payout eligible.
    expect(updated?.retryCount).toBe(1);
    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.retryCount).toBe(2);
    expect(updatedJob?.lastError).toContain("payout cap exceeded");
  });

  it("refunds the campaign balance when the payout fails permanently", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: RETRY_BUDGET_EXHAUSTED,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    expect(creditBalance).toHaveBeenCalledOnce();
    expect(creditBalance).toHaveBeenCalledWith(
      campaign.id,
      expect.any(BigInt),
      expect.stringContaining("payout failed"),
      "REFUND",
      submission.id,
    );
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("failed");
    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
  });

  it("does not refund while the payout is still retryable", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: 0,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    expect(creditBalance).not.toHaveBeenCalled();
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("pending");
    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("queued");
  });

  it("does not refund a payout failure for a task without a campaign", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: null,
      retryCount: RETRY_BUDGET_EXHAUSTED,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    expect(creditBalance).not.toHaveBeenCalled();
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("failed");
  });

  it("still marks the submission failed when the failure refund itself fails", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    vi.mocked(creditBalance).mockRejectedValueOnce(new Error("refund failed"));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: RETRY_BUDGET_EXHAUSTED,
    });

    await expect(processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT")).resolves.toBeUndefined();

    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("failed");
  });
});

// ST-6a: the worker classifies rail errors by StellarPaymentError.retryable.
// Non-retryable (op_no_trust / op_no_destination) → fail immediately + refund,
// even with retry budget remaining (a blind retry can never succeed). Retryable
// (tx_bad_seq after payUsdc's in-call reload) → requeue, no refund, budget intact.
describe("payout-worker rail-error classification (ST-6a)", () => {
  it("fails immediately and refunds on a non-retryable op_no_trust, even with retries left", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(
      new StellarPaymentError("no USDC trustline", "op_no_trust", false),
    );
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: 0, // budget still available — non-retryable must not requeue
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    expect(creditBalance).toHaveBeenCalledOnce();
    expect(creditBalance).toHaveBeenCalledWith(
      campaign.id,
      expect.any(BigInt),
      expect.stringContaining("op_no_trust"),
      "REFUND",
      submission.id,
    );
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("failed");
    expect(updated?.payoutError).toContain("op_no_trust");
    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.retryCount).toBe(3); // budget consumed so it never re-runs
  });

  it("fails immediately on a non-retryable op_no_destination", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(
      new StellarPaymentError("unfunded destination", "op_no_destination", false),
    );
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: 0,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.lastError).toContain("op_no_destination");
    expect(creditBalance).toHaveBeenCalledOnce();
  });

  it("requeues (no refund, budget intact) on a retryable tx_bad_seq StellarPaymentError", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(
      new StellarPaymentError("sustained sequence contention", "tx_bad_seq", true),
    );
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: 0,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountUnits, "SUBMISSION_PAYOUT");

    expect(creditBalance).not.toHaveBeenCalled();
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("pending");
    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("queued");
    expect(updatedJob?.retryCount).toBe(1); // incremented, not exhausted
  });
});
