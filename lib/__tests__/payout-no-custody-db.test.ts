// #39 — an accepted answer is paid instantly and leaves no custodial balance.
//
// End to end through the real submit route, the worker's own claim, and its
// processing of the job: the only thing stubbed is the on-chain broadcast. The
// halves are covered on their own (`app/api/submit/__tests__/route.test.ts` for
// the enqueue, `payout-worker.test.ts` for the payment); this proves the whole
// path never passes through `pendingBalanceUnits` or `UserBalanceLedger`, so an
// instant submission creates nothing the platform holds on a contributor's behalf.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return { ...actual, payReward: vi.fn() };
});

vi.mock("@/lib/rate-limit", async () => ({
  checkWalletRateLimit: vi.fn(async () => false),
}));

vi.mock("@/lib/quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quality")>();
  return { ...actual, checkReasonRepetition: vi.fn(async () => ({ isRepetitive: false })) };
});

vi.mock("@/lib/stellar/balance", () => ({
  checkAndAlert: vi.fn(async () => {}),
}));

// The submit route refuses a wallet with no USDC trustline before any write
// (#133 review). These wallets are generated, not funded, so answer "has one".
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return { ...actual, accountHasUsdcTrustline: vi.fn(async () => true) };
});

import { POST } from "@/app/api/submit/route";
import { claimNextJob, processJob } from "@/lib/payout-worker";
import { payReward } from "@/lib/payout";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createCampaign,
  createCampaignBalance,
  VALID_REASON,
} from "@/tests/helpers/factories";

const REWARD = 2_500_000n;
const TX_HASH = "no-custody-broadcast-hash";

beforeEach(async () => {
  await truncateAll();
  vi.mocked(payReward).mockReset();
  process.env.PLATFORM_FEE_UNITS = "1500000";
});

async function submit(userId: string, taskId: string) {
  const token = await signLabelerJWT(userId);
  return POST(
    new NextRequest("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `labeler_session=${token}` },
      body: JSON.stringify({ taskId, choice: "A", reason: VALID_REASON }),
    }),
  );
}

describe("instant payout creates no custodial balance (#39)", () => {
  it("pays an accepted answer to the wallet without touching the off-chain balance or its ledger", async () => {
    vi.mocked(payReward).mockResolvedValueOnce(TX_HASH);
    const campaign = await createCampaign({ rewardUnits: REWARD, defaultResponseTarget: 10 });
    await createCampaignBalance(campaign.id, 1_000_000_000n);
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submit(user.id, task.id);
    expect(res.status).toBe(200);
    const { submissionId } = await res.json();

    const claimed = await claimNextJob();
    expect(claimed).toMatchObject({ submissionId, type: "SUBMISSION_PAYOUT" });
    await processJob(claimed!.id, claimed!.submissionId, claimed!.userId, claimed!.amountUnits, claimed!.type);

    expect(payReward).toHaveBeenCalledOnce();
    const paid = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(paid).toMatchObject({ payoutStatus: "sent", payoutTxHash: TX_HASH, payoutAmountUnits: REWARD });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.pendingBalanceUnits).toBe(0n);
    expect(after.totalEarnedUnits).toBe(REWARD);
    expect(await prisma.userBalanceLedger.count()).toBe(0);
    expect(await prisma.payoutJob.count({ where: { type: "WITHDRAWAL" } })).toBe(0);
  });
});
