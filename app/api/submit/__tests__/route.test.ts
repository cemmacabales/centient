import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return {
    ...actual,
    payReward: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", async () => ({
  checkWalletRateLimit: vi.fn(async () => false),
  isLoginRateLimited: vi.fn(async () => false),
  recordLoginFailure: vi.fn(async () => {}),
  resetLoginFailures: vi.fn(async () => {}),
}));

vi.mock("@/lib/quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quality")>();
  return {
    ...actual,
    checkReasonRepetition: vi.fn(async () => ({ isRepetitive: false })),
  };
});

vi.mock("@/lib/campaign-balance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/campaign-balance")>();
  return {
    ...actual,
    checkAndDebit: vi.fn(),
    creditBalance: vi.fn(),
  };
});

import { POST } from "@/app/api/submit/route";
import { payReward } from "@/lib/payout";
import { checkWalletRateLimit } from "@/lib/rate-limit";
import { checkReasonRepetition } from "@/lib/quality";
import { checkAndDebit, creditBalance, InsufficientBalanceError } from "@/lib/campaign-balance";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createGoldTask,
  createCampaign,
  seedSubmissions,
  makeWallet,
  VALID_REASON,
} from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
  vi.mocked(payReward).mockReset();
  vi.mocked(checkWalletRateLimit).mockReset();
  vi.mocked(checkWalletRateLimit).mockResolvedValue(false);
  vi.mocked(checkReasonRepetition).mockReset();
  vi.mocked(checkReasonRepetition).mockResolvedValue({ isRepetitive: false });
  vi.mocked(checkAndDebit).mockReset();
  vi.mocked(checkAndDebit).mockResolvedValue(undefined);
  vi.mocked(creditBalance).mockReset();
  vi.mocked(creditBalance).mockResolvedValue(0n);
  process.env.PLATFORM_FEE_WEI = "150000000000000000";
});

function makeReq(body: unknown): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

async function submit(payload: Record<string, unknown>) {
  return POST(makeReq(payload));
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    walletAddress: makeWallet(),
    taskId: "task-pending",
    choice: "A",
    reason: VALID_REASON,
    ...overrides,
  };
}

describe("POST /api/submit - validation", () => {
  it("returns 400 invalid_body when JSON is malformed", async () => {
    const res = await POST(makeReq("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 invalid_wallet for missing address", async () => {
    const res = await submit({ taskId: "t1", choice: "A", reason: VALID_REASON });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_wallet" });
  });

  it("returns 400 invalid_wallet for non-hex address", async () => {
    const res = await submit(
      validPayload({ walletAddress: "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_wallet");
  });

  it("normalises mixed-case wallet to lowercase", async () => {
    const task = await createTask();
    const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
    const expected = mixed.toLowerCase();

    const res = await submit(
      validPayload({ walletAddress: mixed, taskId: task.id, choice: "A" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.submissionId).toBeDefined();

    const user = await prisma.user.findUnique({ where: { walletAddress: expected } });
    expect(user).not.toBeNull();
  });

  it("returns 400 invalid_task when taskId is missing", async () => {
    const res = await submit(validPayload({ taskId: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_task");
  });

  it("returns 400 invalid_task when taskId is empty string", async () => {
    const res = await submit(validPayload({ taskId: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_task");
  });

  it("returns 400 invalid_choice for non-A/B choice", async () => {
    const res = await submit(validPayload({ choice: "C" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_choice");
  });

  it("returns 400 invalid_reason for too-short reason", async () => {
    const res = await submit(validPayload({ reason: "short" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_reason");
  });

  it("returns 400 invalid_reason for spam (single char repeated)", async () => {
    const res = await submit(validPayload({ reason: "aaaaaaaaaa" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_reason");
  });

  it("returns 400 invalid_reason for non-string reason", async () => {
    const res = await submit(validPayload({ reason: 12345 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_reason");
  });

  it("returns 400 repetitive_reason when checkReasonRepetition flags it", async () => {
    vi.mocked(checkReasonRepetition).mockResolvedValueOnce({ isRepetitive: true });
    const res = await submit(validPayload());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("repetitive_reason");
  });
});

describe("POST /api/submit - guards", () => {
  it("returns 403 banned for permanently banned user", async () => {
    const wallet = makeWallet();
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 3, bannedUntil: new Date(0) });
    const task = await createTask();

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("banned");
  });

  it("returns 403 banned for user in cooldown", async () => {
    const wallet = makeWallet();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 1, bannedUntil: future });
    const task = await createTask();

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("banned");
  });

  it("returns 404 task_not_found for unknown task", async () => {
    const res = await submit(validPayload({ taskId: "no-such-task" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("task_not_found");
  });

  it("returns 409 already_submitted for duplicate (wallet, taskId)", async () => {
    const wallet = makeWallet();
    const task = await createTask();
    const user = await createUser({ walletAddress: wallet });
    await prisma.submission.create({
      data: {
        walletAddress: wallet,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountWei: 0,
        payoutStatus: "skipped",
      },
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_submitted");
  });

  it("returns 429 rate_limited on second submit within 15s", async () => {
    const wallet = makeWallet();
    const task1 = await createTask();
    const task2 = await createTask();

    vi.mocked(checkWalletRateLimit)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const first = await submit(validPayload({ walletAddress: wallet, taskId: task1.id }));
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("pending");

    const second = await submit(validPayload({ walletAddress: wallet, taskId: task2.id }));
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe("rate_limited");
  });
});

describe("POST /api/submit - gold tasks", () => {
  it("returns paid:false quality_check_failed for wrong gold answer", async () => {
    const wallet = makeWallet();
    const gold = await createGoldTask("A");

    const res = await submit(
      validPayload({ walletAddress: wallet, taskId: gold.id, choice: "B" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paid: false, reason: "quality_check_failed" });

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: wallet, taskId: gold.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.isGoldCheck).toBe(true);
    expect(submission?.goldPassed).toBe(false);
    expect(submission?.payoutStatus).toBe("skipped");

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.goldAttempted).toBe(1);
    expect(user?.goldCorrect).toBe(0);
  });

  it("increments goldCorrect on correct gold answer", async () => {
    const wallet = makeWallet();
    const gold = await createGoldTask("A");

    const res = await submit(
      validPayload({ walletAddress: wallet, taskId: gold.id, choice: "A" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.goldAttempted).toBe(1);
    expect(user?.goldCorrect).toBe(1);
  });

  it("bans user after 3 wrong gold answers (< 50% success) with 24h cooldown", async () => {
    const wallet = makeWallet();
    const gold1 = await createGoldTask("A");
    const gold2 = await createGoldTask("A");
    const gold3 = await createGoldTask("A");

    for (const task of [gold1, gold2, gold3]) {
      const res = await submit(
        validPayload({ walletAddress: wallet, taskId: task.id, choice: "B" }),
      );
      expect(res.status).toBe(200);
    }

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.goldAttempted).toBe(3);
    expect(user?.goldCorrect).toBe(0);
    expect(user?.isBanned).toBe(true);
    expect(user?.banCount).toBe(1);
    expect(user?.bannedUntil).not.toBeNull();
    // bannedUntil should be ~24h from now
    expect(user!.bannedUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("does not ban user when gold ratio >= 50%", async () => {
    const wallet = makeWallet();
    const gold1 = await createGoldTask("A");
    const gold2 = await createGoldTask("A");
    const gold3 = await createGoldTask("A");
    const gold4 = await createGoldTask("A");

    for (const task of [gold1, gold2, gold3, gold4]) {
      const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("pending");
    }

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.goldAttempted).toBe(4);
    expect(user?.goldCorrect).toBe(4);
    expect(user?.isBanned).toBe(false);
  });
});

describe("POST /api/submit - retest", () => {
  it("allows retest user to submit gold tasks", async () => {
    const wallet = makeWallet();
    const past = new Date(Date.now() - 3600000); // cooldown expired 1h ago
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 1, bannedUntil: past });
    const gold = await createGoldTask("A");

    const res = await submit(
      validPayload({ walletAddress: wallet, taskId: gold.id, choice: "B" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paid: false, reason: "quality_check_failed" });
  });

  it("rejects retest user submitting non-gold task", async () => {
    const wallet = makeWallet();
    const past = new Date(Date.now() - 3600000);
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 1, bannedUntil: past });
    const task = await createTask();

    const res = await submit(
      validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_task");
  });

  it("lifts ban after 3 gold tasks passed with >=60% accuracy", async () => {
    const wallet = makeWallet();
    const past = new Date(Date.now() - 3600000);
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 1, bannedUntil: past });
    const g1 = await createGoldTask("A");
    const g2 = await createGoldTask("A");
    const g3 = await createGoldTask("A");

    await submit(validPayload({ walletAddress: wallet, taskId: g1.id, choice: "A" }));
    await submit(validPayload({ walletAddress: wallet, taskId: g2.id, choice: "A" }));
    await submit(validPayload({ walletAddress: wallet, taskId: g3.id, choice: "A" }));

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.isBanned).toBe(false);
    expect(user?.bannedUntil).toBeNull();
    expect(user?.bannedReason).toBeNull();
  });

  it("escalates to tier 2 when retest failed (<60%)", async () => {
    const wallet = makeWallet();
    const past = new Date(Date.now() - 3600000);
    const now = Date.now();
    const lastBan = new Date(now - 7 * 24 * 60 * 60 * 1000); // 7 days ago, within 30 days
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 1, bannedUntil: past, lastBanAt: lastBan });
    const g1 = await createGoldTask("A");
    const g2 = await createGoldTask("A");
    const g3 = await createGoldTask("A");

    // 1 correct, 2 wrong = 33% < 60%
    await submit(validPayload({ walletAddress: wallet, taskId: g1.id, choice: "A" }));
    await submit(validPayload({ walletAddress: wallet, taskId: g2.id, choice: "B" }));
    await submit(validPayload({ walletAddress: wallet, taskId: g3.id, choice: "B" }));

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.isBanned).toBe(true);
    expect(user?.banCount).toBe(2);
    // 72h cooldown
    expect(user!.bannedUntil!.getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
  });

  it("escalates to permanent on 3rd retest failure", async () => {
    const wallet = makeWallet();
    const past = new Date(Date.now() - 3600000);
    const now = Date.now();
    const lastBan = new Date(now - 1 * 60 * 60 * 1000); // 1h ago
    await createUser({ walletAddress: wallet, isBanned: true, banCount: 2, bannedUntil: past, lastBanAt: lastBan });
    const g1 = await createGoldTask("A");
    const g2 = await createGoldTask("A");
    const g3 = await createGoldTask("A");

    await submit(validPayload({ walletAddress: wallet, taskId: g1.id, choice: "B" }));
    await submit(validPayload({ walletAddress: wallet, taskId: g2.id, choice: "B" }));
    await submit(validPayload({ walletAddress: wallet, taskId: g3.id, choice: "B" }));

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.isBanned).toBe(true);
    expect(user?.banCount).toBe(3);
    expect(user?.bannedUntil).toBeNull(); // permanent
  });
});

describe("POST /api/submit - left-bias guard", () => {
  it("returns 400 left_bias_detected when last 20 submissions are >95% same side", async () => {
    const wallet = makeWallet();
    const task = await createTask();
    await seedSubmissions(wallet, 20, "A");

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("left_bias_detected");

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: wallet, taskId: task.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.payoutStatus).toBe("skipped");
  });

  it("does not trigger left-bias when choices are mixed", async () => {
    const wallet = makeWallet();
    const task = await createTask();
    await seedSubmissions(wallet, 15, "A");
    await seedSubmissions(wallet, 5, "B");

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
  });
});

describe("POST /api/submit - payout", () => {
  it("returns status:pending and submissionId immediately, accrues without a PayoutJob", async () => {
    const wallet = makeWallet();
    const task = await createTask();

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response shape kept as `status: "pending"` for wallet-first client coexistence.
    expect(body.status).toBe("pending");
    expect(body.submissionId).toBeDefined();

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: wallet, taskId: task.id },
    });
    expect(submission).not.toBeNull();
    // P2a: the reward is accrued to the user's balance, not paid per-question.
    expect(submission?.payoutStatus).toBe("accrued");
    expect(submission?.payoutTxHash).toBeNull();

    // No per-question PayoutJob is enqueued under accrual.
    expect(await prisma.payoutJob.count()).toBe(0);
  });

  it("does not call payReward directly (payout happens async)", async () => {
    const wallet = makeWallet();
    const task = await createTask();

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(payReward)).not.toHaveBeenCalled();
  });
});

describe("POST /api/submit - response target cap", () => {
  it("returns 409 response_target_reached when task-level target is met", async () => {
    const wallet = makeWallet();
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id, responseTarget: 2 });

    const other1 = makeWallet();
    const other2 = makeWallet();
    const user1 = await createUser({ walletAddress: other1 });
    const user2 = await createUser({ walletAddress: other2 });
    await createUser({ walletAddress: wallet });

    await prisma.submission.createMany({
      data: [
        { walletAddress: other1, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "sent" },
        { walletAddress: other2, userId: user2.id, taskId: task.id, choice: "B", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "sent" },
      ],
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });

  it("returns 409 response_target_reached when campaign-level target is met (task null)", async () => {
    const wallet = makeWallet();
    const campaign = await createCampaign({ defaultResponseTarget: 1 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const other = makeWallet();
    const otherUser = await createUser({ walletAddress: other });
    await createUser({ walletAddress: wallet });
    await prisma.submission.create({
      data: {
        walletAddress: other,
        userId: otherUser.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountWei: 1,
        payoutStatus: "sent",
      },
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });

  it("returns 409 when target is met by confirmed submissions", async () => {
    const wallet = makeWallet();
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id, responseTarget: 2 });

    const other1 = makeWallet();
    const other2 = makeWallet();
    const user1 = await createUser({ walletAddress: other1 });
    const user2 = await createUser({ walletAddress: other2 });
    await createUser({ walletAddress: wallet });

    await prisma.submission.createMany({
      data: [
        { walletAddress: other1, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "confirmed", isGoldCheck: false },
        { walletAddress: other2, userId: user2.id, taskId: task.id, choice: "B", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "confirmed", isGoldCheck: false },
      ],
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });

  it("allows submission when target is not yet met", async () => {
    const wallet = makeWallet();
    const campaign = await createCampaign({ defaultResponseTarget: 3 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const other = makeWallet();
    const otherUser = await createUser({ walletAddress: other });
    await createUser({ walletAddress: wallet });
    await prisma.submission.create({
      data: {
        walletAddress: other,
        userId: otherUser.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountWei: 1,
        payoutStatus: "sent",
      },
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.submissionId).toBeDefined();
  });

  it("gold tasks bypass the response target cap", async () => {
    const wallet = makeWallet();
    const gold = await createGoldTask("A");

    const u1 = makeWallet();
    const u2 = makeWallet();
    const u3 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });
    const user3 = await createUser({ walletAddress: u3 });
    await createUser({ walletAddress: wallet });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: gold.id, choice: "A", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "sent" },
        { walletAddress: u2, userId: user2.id, taskId: gold.id, choice: "A", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "sent" },
        { walletAddress: u3, userId: user3.id, taskId: gold.id, choice: "A", reason: VALID_REASON, payoutAmountWei: 1, payoutStatus: "sent" },
      ],
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: gold.id, choice: "A" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
  });
});

describe("POST /api/submit - daily payout cap", () => {
  it("submit never triggers an on-chain payout (cap is irrelevant under accrual)", async () => {
    const wallet = makeWallet();
    const task = await createTask();

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: wallet, taskId: task.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.payoutStatus).toBe("accrued");
  });
});

describe("POST /api/submit - campaign balance", () => {
  it("debits the campaign balance for non-gold tasks with a campaignId", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(checkAndDebit).toHaveBeenCalledOnce();
    expect(checkAndDebit).toHaveBeenCalledWith(campaign.id, expect.any(BigInt), expect.any(String));
  });

  it("returns 402 and does not pay when the balance is insufficient", async () => {
    vi.mocked(checkAndDebit).mockRejectedValueOnce(
      new InsufficientBalanceError(0n, 200000000000000000n),
    );
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("campaign_balance_insufficient");
    expect(payReward).not.toHaveBeenCalled();

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: user.walletAddress, taskId: task.id },
    });
    expect(submission?.payoutStatus).toBe("skipped");
  });

  it("does not debit gold tasks", async () => {
    const campaign = await createCampaign();
    const task = await createGoldTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: task.goldAnswer as string, reason: VALID_REASON });

    expect(checkAndDebit).not.toHaveBeenCalled();
  });

  it("does not debit tasks without a campaign", async () => {
    const task = await createTask({ campaignId: undefined });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(checkAndDebit).not.toHaveBeenCalled();
  });

  // Refund-on-payout-failure and refund-on-cap now live in the payout worker
  // (payouts are async). See lib/__tests__/payout-worker.test.ts.
});

describe("POST /api/submit - balance accrual", () => {
  it("credits pendingBalanceWei and writes a CREDIT_REWARD ledger row on an approved non-gold answer", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submit({
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
    });
    expect(res.status).toBe(200);

    const submission = await prisma.submission.findFirstOrThrow({
      where: { walletAddress: user.walletAddress, taskId: task.id },
    });
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceWei).toBeGreaterThan(0n);
    expect(refreshed.pendingBalanceWei).toBe(submission.payoutAmountWei);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("CREDIT_REWARD");
    expect(ledger[0].amountWei).toBe(submission.payoutAmountWei);
    expect(ledger[0].submissionId).toBe(submission.id);
  });

  it("marks the accrued submission payoutStatus 'accrued'", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    const submission = await prisma.submission.findFirstOrThrow({ where: { taskId: task.id } });
    expect(submission.payoutStatus).toBe("accrued");
  });

  it("does not enqueue a per-question PayoutJob for accrued earnings", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(await prisma.payoutJob.count()).toBe(0);
  });

  it("does not call payReward (no per-question on-chain transfer)", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(vi.mocked(payReward)).not.toHaveBeenCalled();
  });

  it("credits a correct gold answer to balance without debiting a campaign", async () => {
    const gold = await createGoldTask("A");
    const user = await createUser();

    const res = await submit({ walletAddress: user.walletAddress, taskId: gold.id, choice: "A", reason: VALID_REASON });
    expect(res.status).toBe(200);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceWei).toBeGreaterThan(0n);
    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("CREDIT_REWARD");
    expect(checkAndDebit).not.toHaveBeenCalled();
    expect(await prisma.payoutJob.count()).toBe(0);
  });

  it("still debits the customer campaign balance at answer time (unchanged)", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });

    expect(checkAndDebit).toHaveBeenCalledOnce();
    expect(checkAndDebit).toHaveBeenCalledWith(campaign.id, expect.any(BigInt), expect.any(String));
  });

  it("does not credit balance when the customer campaign balance is insufficient", async () => {
    vi.mocked(checkAndDebit).mockRejectedValueOnce(
      new InsufficientBalanceError(0n, 200000000000000000n),
    );
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submit({ walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON });
    expect(res.status).toBe(402);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceWei).toBe(0n);
    expect(await prisma.userBalanceLedger.count()).toBe(0);
  });

  it("counts accrued submissions toward the response target cap", async () => {
    const wallet = makeWallet();
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id, responseTarget: 1 });

    const other = makeWallet();
    const otherUser = await createUser({ walletAddress: other });
    await createUser({ walletAddress: wallet });
    await prisma.submission.create({
      data: {
        walletAddress: other,
        userId: otherUser.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountWei: 1,
        payoutStatus: "accrued",
        isGoldCheck: false,
      },
    });

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });
});
