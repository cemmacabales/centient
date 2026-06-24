import { vi, describe, it, expect, beforeEach } from "vitest";

// Payouts are async: the route debits the campaign balance up front and enqueues a
// PayoutJob; the worker performs the on-chain transfer. When the worker ends in a
// terminal non-paid state (daily cap reached, or permanently failed), it must reverse
// the debit. These tests cover that refund behaviour (previously tested at the route
// level, before payouts moved off the request path).

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return { ...actual, payReward: vi.fn() };
});

vi.mock("@/lib/campaign-balance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/campaign-balance")>();
  return { ...actual, creditBalance: vi.fn() };
});

vi.mock("@/lib/celo-balance", () => ({
  checkAndAlert: vi.fn(async () => {}),
}));

import { processJob } from "@/lib/payout-worker";
import { payReward, PayoutCapError } from "@/lib/payout";
import { creditBalance } from "@/lib/campaign-balance";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, createCampaign, VALID_REASON } from "@/tests/helpers/factories";

// The worker only marks a job permanently failed once its retry budget is exhausted.
// Seeding retryCount one below MAX_RETRIES makes the next attempt terminal.
const RETRY_BUDGET_EXHAUSTED = 2;
const AMOUNT_WEI = 50000000000000000n;

async function enqueuePendingPayout(opts: {
  campaignId?: string | null;
  isGold?: boolean;
  retryCount?: number;
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
      payoutAmountWei: AMOUNT_WEI,
      payoutStatus: "pending",
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
  process.env.PLATFORM_FEE_WEI = "150000000000000000";
});

describe("payout-worker campaign balance refunds", () => {
  it("refunds the campaign balance when the daily payout cap is reached", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new PayoutCapError(1n, 1n));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({ campaignId: campaign.id });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT");

    expect(creditBalance).toHaveBeenCalledOnce();
    expect(creditBalance).toHaveBeenCalledWith(
      campaign.id,
      expect.any(BigInt),
      expect.stringContaining("payout cap reached"),
      "REFUND",
    );
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("skipped");
    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
  });

  it("refunds the campaign balance when the payout fails permanently", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: RETRY_BUDGET_EXHAUSTED,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT");

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

    await processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT");

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

    await processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT");

    expect(creditBalance).not.toHaveBeenCalled();
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("failed");
  });

  it("does not refund a gold task", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new PayoutCapError(1n, 1n));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      isGold: true,
    });

    await processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT");

    expect(creditBalance).not.toHaveBeenCalled();
    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("skipped");
  });

  it("still marks the submission skipped when the cap refund itself fails", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new PayoutCapError(1n, 1n));
    vi.mocked(creditBalance).mockRejectedValueOnce(new Error("refund failed"));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({ campaignId: campaign.id });

    await expect(processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT")).resolves.toBeUndefined();

    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("skipped");
  });

  it("still marks the submission failed when the failure refund itself fails", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    vi.mocked(creditBalance).mockRejectedValueOnce(new Error("refund failed"));
    const campaign = await createCampaign();
    const { submission, job, user } = await enqueuePendingPayout({
      campaignId: campaign.id,
      retryCount: RETRY_BUDGET_EXHAUSTED,
    });

    await expect(processJob(job.id, submission.id, user.id, submission.payoutAmountWei, "SUBMISSION_PAYOUT")).resolves.toBeUndefined();

    const updated = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(updated?.payoutStatus).toBe("failed");
  });
});
