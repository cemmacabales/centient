import { Keypair } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach } from "vitest";

// #37 — the retry path returns a campaign's debit when it gives up on a payout.
//
// A campaign-backed submission reaches `reprocessPayoutWithNonceSafety` once its
// worker job has ended without paying (a daily-cap deferral, for one). The worker
// refunds the campaign when it gives up; the retry path has to as well, or the
// campaign stays charged for an answer nobody was paid for. Only the broadcast
// is replaced; the claim, the refund, and the ledger run against the database.

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return { ...actual, payReward: vi.fn() };
});
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { payReward, PayoutCapError } from "@/lib/payout";
import { StellarPaymentError } from "@/lib/stellar/client";
import { totalDebitUnits } from "@/lib/campaign-balance";
import { SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createCampaign,
  createCampaignBalance,
  VALID_REASON,
} from "@/tests/helpers/factories";

const REWARD = 2_500_000n;
const AFTER_DEBIT = 1_000_000_000n;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(payReward).mockReset();
  process.env.PLATFORM_FEE_UNITS = "1500000";
});

/** A campaign-backed submission its worker gave up on, balance already debited. */
async function handedToRetryPath(opts: { retryCount: number; campaign?: boolean }) {
  const campaign = opts.campaign === false ? null : await createCampaign({ rewardUnits: REWARD });
  if (campaign) await createCampaignBalance(campaign.id, AFTER_DEBIT);
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: campaign?.id ?? null });
  const submission = await prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: REWARD,
      payoutStatus: "failed",
      retryCount: opts.retryCount,
    },
  });
  return { campaign, submission };
}

async function balanceOf(campaignId: string) {
  return (await prisma.campaignBalance.findUniqueOrThrow({ where: { campaignId } })).balanceUnits;
}

describe("retry path refunds the campaign when a payout is over (#37)", () => {
  it("refunds reward + fee once the retry budget is spent", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const { campaign, submission } = await handedToRetryPath({ retryCount: SUBMISSION_RETRY_BUDGET - 1 });

    await expect(reprocessPayoutWithNonceSafety(submission.id)).rejects.toThrow("rpc timeout");

    expect(await balanceOf(campaign!.id)).toBe(AFTER_DEBIT + totalDebitUnits(REWARD));
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(row.retryCount).toBe(SUBMISSION_RETRY_BUDGET);
  });

  it("refunds at once on a non-retryable error, and takes the row out of the retry budget", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new StellarPaymentError("no trustline", "op_no_trust", false));
    const { campaign, submission } = await handedToRetryPath({ retryCount: 0 });

    await expect(reprocessPayoutWithNonceSafety(submission.id)).rejects.toThrow();

    expect(await balanceOf(campaign!.id)).toBe(AFTER_DEBIT + totalDebitUnits(REWARD));
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(row.retryCount).toBe(SUBMISSION_RETRY_BUDGET);
  });

  it("does not refund an ambiguous submit, which may have settled", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(
      new StellarPaymentError("submit outcome unknown", "ambiguous_submit", false),
    );
    const { campaign, submission } = await handedToRetryPath({ retryCount: 0 });

    await expect(reprocessPayoutWithNonceSafety(submission.id)).rejects.toThrow();

    expect(await balanceOf(campaign!.id)).toBe(AFTER_DEBIT);
  });

  it("does not refund while retries remain", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const { campaign, submission } = await handedToRetryPath({ retryCount: 0 });

    await expect(reprocessPayoutWithNonceSafety(submission.id)).rejects.toThrow();

    expect(await balanceOf(campaign!.id)).toBe(AFTER_DEBIT);
  });

  it("does not refund a cap deferral", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new PayoutCapError(1n, 1n));
    const { campaign, submission } = await handedToRetryPath({ retryCount: SUBMISSION_RETRY_BUDGET - 1 });

    await reprocessPayoutWithNonceSafety(submission.id);

    expect(await balanceOf(campaign!.id)).toBe(AFTER_DEBIT);
  });

  it("refunds nothing for a campaign-less (platform-funded) task", async () => {
    vi.mocked(payReward).mockRejectedValueOnce(new Error("rpc timeout"));
    const { submission } = await handedToRetryPath({ retryCount: SUBMISSION_RETRY_BUDGET - 1, campaign: false });

    await expect(reprocessPayoutWithNonceSafety(submission.id)).rejects.toThrow();

    expect(await prisma.balanceLedger.count()).toBe(0);
  });
});
