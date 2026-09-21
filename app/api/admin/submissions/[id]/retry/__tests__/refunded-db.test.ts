import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { vi, describe, it, expect, beforeEach } from "vitest";

// #37 — an admin retry never re-pays a submission whose campaign debit was
// refunded. The worker and the retry path both return the debit when they give
// up on a payout. Retrying such a row would pay it from platform funds while the
// campaign keeps its refund, and a second give-up would refund it again. Only
// the Horizon submit is replaced; the route, the ledger, and the refund run for
// real.

const { mockSubmitMultisigPayout, mockGetSession, mockRequireRole } = vi.hoisted(() => ({
  mockSubmitMultisigPayout: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireRole: vi.fn(),
}));

vi.mock("@/lib/stellar/payout-submitter", () => ({ submitMultisigPayout: mockSubmitMultisigPayout }));
vi.mock("@/lib/stellar/payout-cosigner", () => ({
  resolvePayoutCoSigner: vi.fn(() => ({ signPayout: vi.fn() })),
}));
vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));
vi.mock("@/lib/admin-auth", () => ({
  getAdminSession: mockGetSession,
  requireRoleForRoute: mockRequireRole,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { POST } from "../route";
import { creditBalance, totalDebitUnits } from "@/lib/campaign-balance";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createCampaign,
  createCampaignBalance,
  VALID_REASON,
} from "@/tests/helpers/factories";

const REWARD = 2_500_000n;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.DAILY_PAYOUT_CAP_UNITS = "0";
  process.env.PLATFORM_FEE_UNITS = "1500000";
  mockGetSession.mockResolvedValue({ email: "ops@centient.test" });
  mockRequireRole.mockResolvedValue(null);
  mockSubmitMultisigPayout.mockResolvedValue({ hash: "retry-hash" });
  await truncateAll();
});

/** A campaign-backed payout that was given up on, lease long expired. */
async function givenUpSubmission(payoutStatus: "failed" | "abandoned") {
  const campaign = await createCampaign({ rewardUnits: REWARD });
  await createCampaignBalance(campaign.id, 1_000_000_000n);
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: campaign.id });
  const submission = await prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: REWARD,
      payoutStatus,
      retryCount: 5,
      lastRetriedAt: new Date(Date.now() - 10 * 60_000),
    },
  });
  return { campaign, submission };
}

const retry = (id: string) =>
  POST(new NextRequest(`http://localhost/api/admin/submissions/${id}/retry`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

describe("admin retry of a refunded submission (#37)", () => {
  it.each(["failed", "abandoned"] as const)("refuses the %s row whose debit was refunded", async (status) => {
    const { campaign, submission } = await givenUpSubmission(status);
    await creditBalance(campaign.id, totalDebitUnits(REWARD), "refund: payout failed for submission x", "REFUND", submission.id);

    const res = await retry(submission.id);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("payout_refunded");
    expect(mockSubmitMultisigPayout).not.toHaveBeenCalled();
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(row).toMatchObject({ payoutStatus: status, retryCount: 5 });
  });

  it("refuses a row refunded before refunds carried the submission id", async () => {
    const { campaign, submission } = await givenUpSubmission("failed");
    await prisma.balanceLedger.create({
      data: {
        campaignId: campaign.id,
        type: "REFUND",
        amountUnits: totalDebitUnits(REWARD),
        note: `refund: payout failed for submission ${submission.id}`,
      },
    });

    const res = await retry(submission.id);

    expect(res.status).toBe(409);
    expect(mockSubmitMultisigPayout).not.toHaveBeenCalled();
  });

  it("still retries a failed row that was never refunded", async () => {
    const { submission } = await givenUpSubmission("failed");

    const res = await retry(submission.id);

    expect(res.status).toBe(200);
    expect(mockSubmitMultisigPayout).toHaveBeenCalledTimes(1);
  });
});

describe("a campaign refund is applied once per submission (#37)", () => {
  it("returns the debit once when two payers give up on the same payout", async () => {
    const { campaign, submission } = await givenUpSubmission("failed");
    const refund = () =>
      creditBalance(campaign.id, totalDebitUnits(REWARD), "refund", "REFUND", submission.id);

    await Promise.all([refund(), refund(), refund()]);

    const balance = await prisma.campaignBalance.findUniqueOrThrow({ where: { campaignId: campaign.id } });
    expect(balance.balanceUnits).toBe(1_000_000_000n + totalDebitUnits(REWARD));
    expect(await prisma.balanceLedger.count({ where: { type: "REFUND", submissionId: submission.id } })).toBe(1);
  });
});
