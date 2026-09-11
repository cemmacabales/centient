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
