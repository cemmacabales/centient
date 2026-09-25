// #36 — every rejected submission path creates no payout intent.
//
// "Payout intent" is anything a payout could be hung off: a campaign debit
// (`BalanceLedger` + `CampaignBalance`), a labeler credit (`UserBalanceLedger` +
// `User.pendingBalanceUnits`), a `PayoutJob`, or a `Submission` that reads as
// rewarded (a rewarded status or a non-zero amount). #37 made the accepted
// path an instant payout — a pending row plus a SUBMISSION_PAYOUT job the
// worker broadcasts — so a rejection that leaves any of these behind would be
// paid. The debit and credit run for real here; only the rate limit
// and the repetition check are stubbed, to trigger them deterministically.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async () => ({
  checkWalletRateLimit: vi.fn(async () => false),
}));

vi.mock("@/lib/quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quality")>();
  return {
    ...actual,
    checkReasonRepetition: vi.fn(async () => ({ isRepetitive: false })),
  };
});

// The submit route refuses a wallet with no USDC trustline before any write
// (#133 review). These wallets are generated, not funded, so answer "has one".
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return { ...actual, accountHasUsdcTrustline: vi.fn(async () => true) };
});

import * as Sentry from "@sentry/nextjs";
import { POST } from "@/app/api/submit/route";
import { checkWalletRateLimit } from "@/lib/rate-limit";
import { checkReasonRepetition } from "@/lib/quality";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { REWARDED_STATUSES } from "@/lib/constants";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createGoldTask,
  createCampaign,
  createCampaignBalance,
  seedSubmissionsForUser,
  VALID_REASON,
} from "@/tests/helpers/factories";

const REWARD = 2_500_000n;
const FUNDED = 1_000_000_000n;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(checkWalletRateLimit).mockReset();
  vi.mocked(checkWalletRateLimit).mockResolvedValue(false);
  vi.mocked(checkReasonRepetition).mockReset();
  vi.mocked(checkReasonRepetition).mockResolvedValue({ isRepetitive: false });
  vi.mocked(Sentry.captureMessage).mockReset();
  process.env.PLATFORM_FEE_UNITS = "1500000";
});

/** A funded campaign task: the accepted path would debit it and credit the labeler. */
async function fundedCampaignTask(balance: bigint = FUNDED) {
  const campaign = await createCampaign({ rewardUnits: REWARD, defaultResponseTarget: 10 });
  await createCampaignBalance(campaign.id, balance);
  const task = await createTask({ campaignId: campaign.id });
  return { campaign, task };
}

async function submit(userId: string, taskId: string, overrides: Record<string, unknown> = {}) {
  const token = await signLabelerJWT(userId);
  return POST(
    new NextRequest("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `labeler_session=${token}` },
      body: JSON.stringify({ taskId, choice: "A", reason: VALID_REASON, ...overrides }),
    }),
  );
}

/** Every payout-intent store, as totals that a rejection must leave unchanged. */
async function payoutIntent(userId: string, campaignId: string) {
  const [campaignLedger, userLedger, payoutJobs, user, balance] = await Promise.all([
    prisma.balanceLedger.count(),
    prisma.userBalanceLedger.count(),
    prisma.payoutJob.count(),
    prisma.user.findUnique({ where: { id: userId }, select: { pendingBalanceUnits: true } }),
    prisma.campaignBalance.findUnique({ where: { campaignId }, select: { balanceUnits: true } }),
  ]);
  return {
    campaignLedger,
    userLedger,
    payoutJobs,
    pendingBalanceUnits: user?.pendingBalanceUnits ?? null,
    campaignBalanceUnits: balance?.balanceUnits ?? null,
  };
}

/**
 * Submit, then assert the rejection left no payout intent: no store moved, and
 * any `Submission` the request wrote reads as skipped with no amount.
 */
async function expectNoPayoutIntent(
  userId: string,
  taskId: string,
  campaignId: string,
  overrides: Record<string, unknown> = {},
) {
  const before = await payoutIntent(userId, campaignId);
  const startedAt = new Date();
  const res = await submit(userId, taskId, overrides);
  const after = await payoutIntent(userId, campaignId);

  expect(after).toEqual(before);
  const written = await prisma.submission.findMany({
    where: { userId, createdAt: { gte: startedAt } },
    select: { payoutStatus: true, payoutAmountUnits: true },
  });
  for (const s of written) {
    expect(REWARDED_STATUSES as readonly string[]).not.toContain(s.payoutStatus);
    expect(s.payoutStatus).toBe("skipped");
    expect(s.payoutAmountUnits).toBe(0n);
  }
  return res;
}

async function errorOf(res: Response) {
  const body = await res.json();
  return body.error ?? body.reason;
}

describe("POST /api/submit — the accepted path creates payout intent", () => {
  /** The accepted row and every job hung off it. */
  async function acceptedIntent(userId: string, taskId: string) {
    const sub = await prisma.submission.findUniqueOrThrow({
      where: { userId_taskId: { userId, taskId } },
    });
    const jobs = await prisma.payoutJob.findMany({ where: { submissionId: sub.id } });
    return { sub, jobs };
  }

  it("debits the campaign, writes a pending submission, and queues exactly one payout job", async () => {
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask();
    const before = await payoutIntent(user.id, campaign.id);

    const res = await submit(user.id, task.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");

    const after = await payoutIntent(user.id, campaign.id);
    expect(after.campaignLedger).toBe(before.campaignLedger + 2);
    expect(after.campaignBalanceUnits).toBe(FUNDED - REWARD - 1_500_000n);
    // #37: paid on-chain by the worker, so no withdrawable credit as well.
    expect(after.userLedger).toBe(before.userLedger);
    expect(after.pendingBalanceUnits).toBe(before.pendingBalanceUnits);
    expect(after.payoutJobs).toBe(before.payoutJobs + 1);

    const { sub, jobs } = await acceptedIntent(user.id, task.id);
    expect(sub.id).toBe(body.submissionId);
    expect(sub.payoutStatus).toBe("pending");
    expect(sub.payoutAmountUnits).toBe(REWARD);
    expect(sub.payoutTxHash).toBeNull();
    expect(sub.walletAddress).toBe(user.walletAddress);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "SUBMISSION_PAYOUT", status: "queued", txHash: null });
  });

  it("queues a platform-funded payout for a campaign-less task, with no debit", async () => {
    const user = await createUser();
    const { campaign } = await fundedCampaignTask();
    // The live tester questions: no campaign, a per-task reward (0.25 USDC).
    const task = await createTask({ campaignId: null });
    await prisma.task.update({ where: { id: task.id }, data: { rewardUnits: REWARD } });
    const before = await payoutIntent(user.id, campaign.id);

    const res = await submit(user.id, task.id);
    expect(res.status).toBe(200);

    const after = await payoutIntent(user.id, campaign.id);
    expect(after.campaignLedger).toBe(before.campaignLedger);
    expect(after.campaignBalanceUnits).toBe(before.campaignBalanceUnits);
    expect(after.pendingBalanceUnits).toBe(before.pendingBalanceUnits);
    const { sub, jobs } = await acceptedIntent(user.id, task.id);
    expect(sub.payoutStatus).toBe("pending");
    expect(sub.payoutAmountUnits).toBe(REWARD);
    expect(jobs).toHaveLength(1);
  });

  it("rolls back the debit and the row together when the job insert fails", async () => {
    // A real database failure on the third write of the transaction, not a mock:
    // proves the debit, the row, and the job are one unit.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_payout_job() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced payout_jobs insert failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_refuse_payout_job BEFORE INSERT ON "payout_jobs"
      FOR EACH ROW EXECUTE FUNCTION test_refuse_payout_job()`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = await createUser();
      const { campaign, task } = await fundedCampaignTask();
      const before = await payoutIntent(user.id, campaign.id);

      const res = await submit(user.id, task.id);
      expect(res.status).toBe(500);

      expect(await payoutIntent(user.id, campaign.id)).toEqual(before);
      expect(await prisma.submission.count({ where: { userId: user.id, taskId: task.id } })).toBe(0);
    } finally {
      error.mockRestore();
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_payout_job ON "payout_jobs"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_payout_job()`);
    }
  });
});

describe("POST /api/submit — a repeated request converges (#38)", () => {
  it("answers a concurrent duplicate 409 already_submitted, with one debit and one job", async () => {
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask();

    const responses = await Promise.all(Array.from({ length: 4 }, () => submit(user.id, task.id)));

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(await errorOf(res)).toBe("already_submitted");
    }
    expect(await prisma.submission.count({ where: { userId: user.id, taskId: task.id } })).toBe(1);
    expect(await prisma.payoutJob.count()).toBe(1);
    expect(await prisma.balanceLedger.count({ where: { campaignId: campaign.id, type: "DEBIT_REWARD" } })).toBe(1);
  });
});

describe("POST /api/submit — every rejected path creates no payout intent", () => {
  it("spam reason", async () => {
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id, { reason: "asdf" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_reason");
  });

  it("repetitive reason", async () => {
    vi.mocked(checkReasonRepetition).mockResolvedValue({ isRepetitive: true });
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("repetitive_reason");
  });

  it("rate limited", async () => {
    vi.mocked(checkWalletRateLimit).mockResolvedValue(true);
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe("rate_limited");
  });

  it("no bound Stellar wallet", async () => {
    const user = await createUser({ walletAddress: null, email: "nowallet@example.com" });
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("wallet_required");
  });

  it("permanently banned account", async () => {
    const user = await createUser({ isBanned: true, bannedUntil: new Date(0), banCount: 3 });
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("banned");
  });

  it("account in cooldown", async () => {
    const user = await createUser({ isBanned: true, bannedUntil: new Date(Date.now() + 3_600_000) });
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("banned");
  });

  it.each([
    ["WALLET", (u: { walletAddress: string }) => u.walletAddress],
    ["USER_ID", (u: { id: string }) => u.id],
    ["EMAIL", (u: { email: string | null }) => u.email!],
  ] as const)("banned %s identity", async (identifierType, valueOf) => {
    const user = await createUser({ email: "banned-identity@example.com" });
    await prisma.bannedIdentity.create({
      data: { identifierType, identifierValue: valueOf(user as never), reason: "test ban" },
    });
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("banned");
  });

  it("an expired identity ban does not block", async () => {
    const user = await createUser();
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "WALLET",
        identifierValue: user.walletAddress,
        bannedUntil: new Date(Date.now() - 1000),
      },
    });
    const { task } = await fundedCampaignTask();
    const res = await submit(user.id, task.id);
    expect(res.status).toBe(200);
  });

  it("an account banned from a flagged withdrawal (isBanned, no bannedUntil)", async () => {
    // The admin flagged-withdrawal ban writes `isBanned` with no `bannedUntil`,
    // which neither isPermanentlyBanned nor isInCooldown reads as a ban. The
    // BannedIdentity rows it writes alongside are what stop it at submit.
    const user = await createUser({ isBanned: true, bannedUntil: null });
    await prisma.bannedIdentity.create({
      data: { identifierType: "USER_ID", identifierValue: user.id, reason: "flagged withdrawal" },
    });
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("banned");
  });

  it("already submitted", async () => {
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask();
    await prisma.submission.create({
      data: {
        userId: user.id,
        walletAddress: user.walletAddress,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 0n,
        payoutStatus: "skipped",
      },
    });
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("already_submitted");
  });

  it.each(["pending", "sent", "confirmed", "accrued"] as const)(
    "response target reached by another answer that is %s",
    async (payoutStatus) => {
      // #37: an accepted answer is written `pending` and paid out of band, so an
      // in-flight payout must fill the target like a settled one — or the task is
      // answered, and paid, past its target while payouts are in flight.
      const user = await createUser();
      const other = await createUser();
      const campaign = await createCampaign({ rewardUnits: REWARD });
      await createCampaignBalance(campaign.id, FUNDED);
      const task = await createTask({ campaignId: campaign.id, responseTarget: 1 });
      await prisma.submission.create({
        data: {
          userId: other.id,
          walletAddress: other.walletAddress,
          taskId: task.id,
          choice: "A",
          reason: VALID_REASON,
          payoutAmountUnits: REWARD,
          payoutStatus,
        },
      });
      const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe("response_target_reached");
    },
  );

  it.each(["skipped", "failed", "abandoned"] as const)(
    "a %s answer does not fill the response target",
    async (payoutStatus) => {
      const user = await createUser();
      const other = await createUser();
      const campaign = await createCampaign({ rewardUnits: REWARD });
      await createCampaignBalance(campaign.id, FUNDED);
      const task = await createTask({ campaignId: campaign.id, responseTarget: 1 });
      await prisma.submission.create({
        data: {
          userId: other.id,
          walletAddress: other.walletAddress,
          taskId: task.id,
          choice: "A",
          reason: VALID_REASON,
          payoutAmountUnits: 0n,
          payoutStatus,
        },
      });
      const res = await submit(user.id, task.id);
      expect(res.status).toBe(200);
    },
  );

  it("response target reached", async () => {
    const user = await createUser();
    const other = await createUser();
    const campaign = await createCampaign({ rewardUnits: REWARD });
    await createCampaignBalance(campaign.id, FUNDED);
    const task = await createTask({ campaignId: campaign.id, responseTarget: 1 });
    await prisma.submission.create({
      data: {
        userId: other.id,
        walletAddress: other.walletAddress,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: REWARD,
        payoutStatus: "accrued",
      },
    });
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("response_target_reached");
  });

  it("non-gold task while in retest", async () => {
    const user = await createUser({ isBanned: true, bannedUntil: new Date(Date.now() - 1000), banCount: 1 });
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_task");
  });

  it("failed gold check", async () => {
    const user = await createUser();
    const { campaign } = await fundedCampaignTask();
    const gold = await createGoldTask("B");
    const res = await expectNoPayoutIntent(user.id, gold.id, campaign.id);
    expect(res.status).toBe(200);
    expect(await errorOf(res)).toBe("quality_check_failed");
  });

  it("passed gold check (#37: unpaid, revealed only after the answer)", async () => {
    const user = await createUser();
    const { campaign } = await fundedCampaignTask();
    const gold = await createGoldTask("A");
    const res = await expectNoPayoutIntent(user.id, gold.id, campaign.id);
    expect(res.status).toBe(200);
    expect(await errorOf(res)).toBe("quality_check_passed");
    const row = await prisma.submission.findUniqueOrThrow({
      where: { userId_taskId: { userId: user.id, taskId: gold.id } },
    });
    expect(row.goldPassed).toBe(true);
  });

  it("gold check during retest", async () => {
    const user = await createUser({ isBanned: true, bannedUntil: new Date(Date.now() - 1000), banCount: 1 });
    const { campaign } = await fundedCampaignTask();
    const gold = await createGoldTask("A");
    const res = await expectNoPayoutIntent(user.id, gold.id, campaign.id);
    expect(res.status).toBe(200);
    // A correct answer: it says passed (OQ-10) and still earns nothing.
    expect(await errorOf(res)).toBe("quality_check_passed");
  });

  it("left/right bias", async () => {
    const user = await createUser();
    await seedSubmissionsForUser(user.id, 20, "A");
    const { campaign, task } = await fundedCampaignTask();
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("left_bias_detected");
  });

  it("campaign balance too low to pay", async () => {
    const user = await createUser();
    const { campaign, task } = await fundedCampaignTask(0n);
    const res = await expectNoPayoutIntent(user.id, task.id, campaign.id);
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toBe("campaign_balance_insufficient");
  });
});

describe("POST /api/submit — rejection logs carry no anti-abuse working values", () => {
  const THRESHOLD_FIELDS = ["sameSide", "recent", "accuracy", "passed", "total", "goldAttempted", "goldCorrect"];

  /** Every context object handed to console.error/warn or Sentry during `fn`. */
  async function loggedContexts(fn: () => Promise<unknown>) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fn();
      return [
        ...error.mock.calls.map((c) => c[1]),
        ...warn.mock.calls.map((c) => c[1]),
        ...vi.mocked(Sentry.captureMessage).mock.calls.map((c) => (c[1] as { extra?: unknown })?.extra),
      ].filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  }

  function expectScrubbed(contexts: Record<string, unknown>[]) {
    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) {
      for (const field of THRESHOLD_FIELDS) expect(ctx).not.toHaveProperty(field);
      expect(JSON.stringify(ctx)).not.toContain(VALID_REASON);
    }
  }

  it("left_bias_detected", async () => {
    const user = await createUser();
    await seedSubmissionsForUser(user.id, 20, "A");
    const { task } = await fundedCampaignTask();
    expectScrubbed(await loggedContexts(() => submit(user.id, task.id)));
  });

  it("a gold failure that bans the account", async () => {
    const user = await createUser({ goldAttempted: 9, goldCorrect: 0 });
    const gold = await createGoldTask("B");
    expectScrubbed(await loggedContexts(() => submit(user.id, gold.id)));
    const banned = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(banned.isBanned).toBe(true);
  });

  it("a retest that completes", async () => {
    const user = await createUser({ isBanned: true, bannedUntil: new Date(Date.now() - 1000), banCount: 1 });
    const golds = await Promise.all([createGoldTask("B"), createGoldTask("B"), createGoldTask("B")]);
    const contexts = await loggedContexts(async () => {
      for (const g of golds) await submit(user.id, g.id);
    });
    expectScrubbed(contexts);
  });
});
