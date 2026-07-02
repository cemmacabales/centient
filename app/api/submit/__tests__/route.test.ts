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
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createGoldTask,
  createCampaign,
  seedSubmissionsForUser,
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
  process.env.PLATFORM_FEE_UNITS = "150000000000000000";
});

function makeReq(body: unknown, token?: string): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.cookie = `labeler_session=${token}`;
  return new NextRequest("http://localhost/api/submit", {
    method: "POST",
    headers,
    body: raw,
  });
}

// Identity is the session (userId) as of ST-5d — the wallet is no longer sent
// in the body. Drive the route with a signed session cookie for an existing user.
async function submitAs(userId: string, payload: unknown) {
  const token = await signLabelerJWT(userId);
  return POST(makeReq(payload, token));
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-pending",
    choice: "A",
    reason: VALID_REASON,
    ...overrides,
  };
}

describe("POST /api/submit - session auth", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await POST(makeReq(validPayload()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 401 for a tampered token", async () => {
    const res = await POST(makeReq(validPayload(), "not.a.valid.jwt"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session user no longer exists", async () => {
    const token = await signLabelerJWT("00000000-0000-0000-0000-000000000000");
    const task = await createTask();
    const res = await POST(makeReq(validPayload({ taskId: task.id }), token));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/submit - validation", () => {
  it("returns 400 invalid_body when JSON is malformed", async () => {
    const user = await createUser();
    const token = await signLabelerJWT(user.id);
    const res = await POST(makeReq("{not json", token));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 invalid_task when taskId is missing", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ taskId: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_task");
  });

  it("returns 400 invalid_task when taskId is empty string", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ taskId: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_task");
  });

  it("returns 400 invalid_choice for non-A/B choice", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ choice: "C" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_choice");
  });

  it("returns 400 invalid_reason for too-short reason", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ reason: "short" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_reason");
  });

  it("returns 400 invalid_reason for spam (single char repeated)", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ reason: "aaaaaaaaaa" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_reason");
  });

  it("returns 400 invalid_reason for non-string reason", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ reason: 12345 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_reason");
  });

  it("returns 400 repetitive_reason when checkReasonRepetition flags it", async () => {
    vi.mocked(checkReasonRepetition).mockResolvedValueOnce({ isRepetitive: true });
    const user = await createUser();
    const res = await submitAs(user.id, validPayload());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("repetitive_reason");
  });
});

describe("POST /api/submit - email-only user (no linked wallet)", () => {
  it("accrues an approved answer for a user whose walletAddress is null", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser({ walletAddress: null, email: "labeler@example.com" });

    const res = await submitAs(user.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.submissionId).toBeDefined();

    const submission = await prisma.submission.findUniqueOrThrow({
      where: { userId_taskId: { userId: user.id, taskId: task.id } },
    });
    expect(submission.walletAddress).toBeNull();
    expect(submission.payoutStatus).toBe("accrued");

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceUnits).toBeGreaterThan(0n);
  });
});

describe("POST /api/submit - guards", () => {
  it("returns 403 banned for permanently banned user", async () => {
    const user = await createUser({ isBanned: true, banCount: 3, bannedUntil: new Date(0) });
    const task = await createTask();

    const res = await submitAs(user.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("banned");
  });

  it("returns 403 banned for user in cooldown", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await createUser({ isBanned: true, banCount: 1, bannedUntil: future });
    const task = await createTask();

    const res = await submitAs(user.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("banned");
  });

  it("returns 404 task_not_found for unknown task", async () => {
    const user = await createUser();
    const res = await submitAs(user.id, validPayload({ taskId: "no-such-task" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("task_not_found");
  });

  it("returns 409 already_submitted for duplicate (userId, taskId)", async () => {
    const task = await createTask();
    const user = await createUser();
    await prisma.submission.create({
      data: {
        walletAddress: user.walletAddress,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 0,
        payoutStatus: "skipped",
      },
    });

    const res = await submitAs(user.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_submitted");
  });

  it("returns 429 rate_limited on second submit within 15s", async () => {
    const user = await createUser();
    const task1 = await createTask();
    const task2 = await createTask();

    vi.mocked(checkWalletRateLimit)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const first = await submitAs(user.id, validPayload({ taskId: task1.id }));
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("pending");

    const second = await submitAs(user.id, validPayload({ taskId: task2.id }));
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe("rate_limited");
  });

  it("rate-limits on the userId (opaque key), not a wallet", async () => {
    const user = await createUser({ walletAddress: null });
    const task = await createTask();
    vi.mocked(checkWalletRateLimit).mockResolvedValueOnce(false);

    const res = await submitAs(user.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(200);
    expect(vi.mocked(checkWalletRateLimit)).toHaveBeenCalledWith(user.id);
  });
});

describe("POST /api/submit - gold tasks", () => {
  it("returns paid:false quality_check_failed for wrong gold answer", async () => {
    const user = await createUser();
    const gold = await createGoldTask("A");

    const res = await submitAs(user.id, validPayload({ taskId: gold.id, choice: "B" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paid: false, reason: "quality_check_failed" });

    const submission = await prisma.submission.findFirst({
      where: { userId: user.id, taskId: gold.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.isGoldCheck).toBe(true);
    expect(submission?.goldPassed).toBe(false);
    expect(submission?.payoutStatus).toBe("skipped");

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.goldAttempted).toBe(1);
    expect(refreshed.goldCorrect).toBe(0);
  });

  it("increments goldCorrect on correct gold answer", async () => {
    const user = await createUser();
    const gold = await createGoldTask("A");

    const res = await submitAs(user.id, validPayload({ taskId: gold.id, choice: "A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.goldAttempted).toBe(1);
    expect(refreshed.goldCorrect).toBe(1);
  });

  it("bans user after 3 wrong gold answers (< 50% success) with 24h cooldown", async () => {
    const user = await createUser();
    const gold1 = await createGoldTask("A");
    const gold2 = await createGoldTask("A");
    const gold3 = await createGoldTask("A");

    for (const task of [gold1, gold2, gold3]) {
      const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "B" }));
      expect(res.status).toBe(200);
    }

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.goldAttempted).toBe(3);
    expect(refreshed.goldCorrect).toBe(0);
    expect(refreshed.isBanned).toBe(true);
    expect(refreshed.banCount).toBe(1);
    expect(refreshed.bannedUntil).not.toBeNull();
    expect(refreshed.bannedUntil!.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("does not ban user when gold ratio >= 50%", async () => {
    const user = await createUser();
    const gold1 = await createGoldTask("A");
    const gold2 = await createGoldTask("A");
    const gold3 = await createGoldTask("A");
    const gold4 = await createGoldTask("A");

    for (const task of [gold1, gold2, gold3, gold4]) {
      const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("pending");
    }

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.goldAttempted).toBe(4);
    expect(refreshed.goldCorrect).toBe(4);
    expect(refreshed.isBanned).toBe(false);
  });
});

describe("POST /api/submit - retest", () => {
  it("allows retest user to submit gold tasks", async () => {
    const past = new Date(Date.now() - 3600000); // cooldown expired 1h ago
    const user = await createUser({ isBanned: true, banCount: 1, bannedUntil: past });
    const gold = await createGoldTask("A");

    const res = await submitAs(user.id, validPayload({ taskId: gold.id, choice: "B" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paid: false, reason: "quality_check_failed" });
  });

  it("rejects retest user submitting non-gold task", async () => {
    const past = new Date(Date.now() - 3600000);
    const user = await createUser({ isBanned: true, banCount: 1, bannedUntil: past });
    const task = await createTask();

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_task");
  });

  it("lifts ban after 3 gold tasks passed with >=60% accuracy", async () => {
    const past = new Date(Date.now() - 3600000);
    const user = await createUser({ isBanned: true, banCount: 1, bannedUntil: past });
    const g1 = await createGoldTask("A");
    const g2 = await createGoldTask("A");
    const g3 = await createGoldTask("A");

    await submitAs(user.id, validPayload({ taskId: g1.id, choice: "A" }));
    await submitAs(user.id, validPayload({ taskId: g2.id, choice: "A" }));
    await submitAs(user.id, validPayload({ taskId: g3.id, choice: "A" }));

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.isBanned).toBe(false);
    expect(refreshed.bannedUntil).toBeNull();
    expect(refreshed.bannedReason).toBeNull();
  });

  it("escalates to tier 2 when retest failed (<60%)", async () => {
    const past = new Date(Date.now() - 3600000);
    const now = Date.now();
    const lastBan = new Date(now - 7 * 24 * 60 * 60 * 1000); // 7 days ago, within 30 days
    const user = await createUser({ isBanned: true, banCount: 1, bannedUntil: past, lastBanAt: lastBan });
    const g1 = await createGoldTask("A");
    const g2 = await createGoldTask("A");
    const g3 = await createGoldTask("A");

    // 1 correct, 2 wrong = 33% < 60%
    await submitAs(user.id, validPayload({ taskId: g1.id, choice: "A" }));
    await submitAs(user.id, validPayload({ taskId: g2.id, choice: "B" }));
    await submitAs(user.id, validPayload({ taskId: g3.id, choice: "B" }));

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.isBanned).toBe(true);
    expect(refreshed.banCount).toBe(2);
    expect(refreshed.bannedUntil!.getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
  });

  it("escalates to permanent on 3rd retest failure", async () => {
    const past = new Date(Date.now() - 3600000);
    const now = Date.now();
    const lastBan = new Date(now - 1 * 60 * 60 * 1000); // 1h ago
    const user = await createUser({ isBanned: true, banCount: 2, bannedUntil: past, lastBanAt: lastBan });
    const g1 = await createGoldTask("A");
    const g2 = await createGoldTask("A");
    const g3 = await createGoldTask("A");

    await submitAs(user.id, validPayload({ taskId: g1.id, choice: "B" }));
    await submitAs(user.id, validPayload({ taskId: g2.id, choice: "B" }));
    await submitAs(user.id, validPayload({ taskId: g3.id, choice: "B" }));

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.isBanned).toBe(true);
    expect(refreshed.banCount).toBe(3);
    expect(refreshed.bannedUntil).toBeNull(); // permanent
  });
});

describe("POST /api/submit - left-bias guard", () => {
  it("returns 400 left_bias_detected when last 20 submissions are >95% same side", async () => {
    const user = await createUser();
    const task = await createTask();
    await seedSubmissionsForUser(user.id, 20, "A");

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("left_bias_detected");

    const submission = await prisma.submission.findFirst({
      where: { userId: user.id, taskId: task.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.payoutStatus).toBe("skipped");
  });

  it("does not trigger left-bias when choices are mixed", async () => {
    const user = await createUser();
    const task = await createTask();
    await seedSubmissionsForUser(user.id, 15, "A");
    await seedSubmissionsForUser(user.id, 5, "B");

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
  });
});

describe("POST /api/submit - payout", () => {
  it("returns status:pending and submissionId immediately, accrues without a PayoutJob", async () => {
    const user = await createUser();
    const task = await createTask();

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.submissionId).toBeDefined();

    const submission = await prisma.submission.findFirst({
      where: { userId: user.id, taskId: task.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.payoutStatus).toBe("accrued");
    expect(submission?.payoutTxHash).toBeNull();

    expect(await prisma.payoutJob.count()).toBe(0);
  });

  it("does not call payReward directly (payout happens async)", async () => {
    const user = await createUser();
    const task = await createTask();

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(payReward)).not.toHaveBeenCalled();
  });
});

describe("POST /api/submit - response target cap", () => {
  it("returns 409 response_target_reached when task-level target is met", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id, responseTarget: 2 });

    const user1 = await createUser();
    const user2 = await createUser();
    const me = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent" },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: task.id, choice: "B", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent" },
      ],
    });

    const res = await submitAs(me.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });

  it("returns 409 response_target_reached when campaign-level target is met (task null)", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 1 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const other = await createUser();
    const me = await createUser();
    await prisma.submission.create({
      data: {
        walletAddress: other.walletAddress,
        userId: other.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 1,
        payoutStatus: "sent",
      },
    });

    const res = await submitAs(me.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });

  it("returns 409 when target is met by confirmed submissions", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id, responseTarget: 2 });

    const user1 = await createUser();
    const user2 = await createUser();
    const me = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "confirmed", isGoldCheck: false },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: task.id, choice: "B", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "confirmed", isGoldCheck: false },
      ],
    });

    const res = await submitAs(me.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });

  it("allows submission when target is not yet met", async () => {
    const campaign = await createCampaign({ defaultResponseTarget: 3 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const other = await createUser();
    const me = await createUser();
    await prisma.submission.create({
      data: {
        walletAddress: other.walletAddress,
        userId: other.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 1,
        payoutStatus: "sent",
      },
    });

    const res = await submitAs(me.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.submissionId).toBeDefined();
  });

  it("gold tasks bypass the response target cap", async () => {
    const gold = await createGoldTask("A");

    const user1 = await createUser();
    const user2 = await createUser();
    const user3 = await createUser();
    const me = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: gold.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent" },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: gold.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent" },
        { walletAddress: user3.walletAddress, userId: user3.id, taskId: gold.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent" },
      ],
    });

    const res = await submitAs(me.id, validPayload({ taskId: gold.id, choice: "A" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
  });
});

describe("POST /api/submit - daily payout cap", () => {
  it("submit never triggers an on-chain payout (cap is irrelevant under accrual)", async () => {
    const user = await createUser();
    const task = await createTask();

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");

    const submission = await prisma.submission.findFirst({
      where: { userId: user.id, taskId: task.id },
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

    await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

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

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("campaign_balance_insufficient");
    expect(payReward).not.toHaveBeenCalled();

    const submission = await prisma.submission.findFirst({
      where: { userId: user.id, taskId: task.id },
    });
    expect(submission?.payoutStatus).toBe("skipped");
  });

  it("does not debit gold tasks", async () => {
    const campaign = await createCampaign();
    const task = await createGoldTask({ campaignId: campaign.id });
    const user = await createUser();

    await submitAs(user.id, validPayload({ taskId: task.id, choice: task.goldAnswer as string }));

    expect(checkAndDebit).not.toHaveBeenCalled();
  });

  it("does not debit tasks without a campaign", async () => {
    const task = await createTask({ campaignId: undefined });
    const user = await createUser();

    await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

    expect(checkAndDebit).not.toHaveBeenCalled();
  });
});

describe("POST /api/submit - balance accrual", () => {
  it("credits pendingBalanceUnits and writes a CREDIT_REWARD ledger row on an approved non-gold answer", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);

    const submission = await prisma.submission.findFirstOrThrow({
      where: { userId: user.id, taskId: task.id },
    });
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceUnits).toBeGreaterThan(0n);
    expect(refreshed.pendingBalanceUnits).toBe(submission.payoutAmountUnits);

    const ledger = await prisma.userBalanceLedger.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("CREDIT_REWARD");
    expect(ledger[0].amountUnits).toBe(submission.payoutAmountUnits);
    expect(ledger[0].submissionId).toBe(submission.id);
  });

  it("marks the accrued submission payoutStatus 'accrued'", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

    const submission = await prisma.submission.findFirstOrThrow({ where: { taskId: task.id } });
    expect(submission.payoutStatus).toBe("accrued");
  });

  it("does not enqueue a per-question PayoutJob for accrued earnings", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

    expect(await prisma.payoutJob.count()).toBe(0);
  });

  it("does not call payReward (no per-question on-chain transfer)", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

    expect(vi.mocked(payReward)).not.toHaveBeenCalled();
  });

  it("credits a correct gold answer to balance without debiting a campaign", async () => {
    const gold = await createGoldTask("A");
    const user = await createUser();

    const res = await submitAs(user.id, validPayload({ taskId: gold.id, choice: "A" }));
    expect(res.status).toBe(200);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceUnits).toBeGreaterThan(0n);
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

    await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));

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

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(402);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceUnits).toBe(0n);
    expect(await prisma.userBalanceLedger.count()).toBe(0);
  });

  it("counts accrued submissions toward the response target cap", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id, responseTarget: 1 });

    const other = await createUser();
    const me = await createUser();
    await prisma.submission.create({
      data: {
        walletAddress: other.walletAddress,
        userId: other.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 1,
        payoutStatus: "accrued",
        isGoldCheck: false,
      },
    });

    const res = await submitAs(me.id, validPayload({ taskId: task.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("response_target_reached");
  });
});

// P5b (#268): accrue-then-withdraw is the ONLY payout path for new earnings. The
// per-question PayoutJob enqueue was retired in P2a; these tests are the regression
// guard that fails if it is ever reintroduced — an approved answer must never
// create a PayoutJob, and certainly never a per-question SUBMISSION_PAYOUT job.
describe("POST /api/submit - P5b regression: accrual is the only payout path", () => {
  it("creates no PayoutJob of any type for an approved answer", async () => {
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);

    expect(await prisma.payoutJob.count()).toBe(0);
    expect(await prisma.payoutJob.count({ where: { type: "SUBMISSION_PAYOUT" } })).toBe(0);
  });

  it("never enqueues a SUBMISSION_PAYOUT job across many approved answers", async () => {
    const campaign = await createCampaign();
    const user = await createUser();

    for (let i = 0; i < 5; i++) {
      const task = await createTask({ campaignId: campaign.id, prompt: `Test prompt ${i}?` });
      const res = await submitAs(user.id, validPayload({ taskId: task.id, choice: "A" }));
      expect(res.status).toBe(200);
    }

    expect(await prisma.payoutJob.count({ where: { type: "SUBMISSION_PAYOUT" } })).toBe(0);
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.pendingBalanceUnits).toBeGreaterThan(0n);
  });
});
