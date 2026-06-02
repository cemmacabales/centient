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

import { POST } from "@/app/api/submit/route";
import { payReward } from "@/lib/payout";
import { checkWalletRateLimit } from "@/lib/rate-limit";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createUser,
  createTask,
  createGoldTask,
  seedSubmissions,
  makeWallet,
  VALID_REASON,
} from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
  vi.mocked(payReward).mockReset();
  vi.mocked(checkWalletRateLimit).mockReset();
  vi.mocked(checkWalletRateLimit).mockResolvedValue(false);
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

    vi.mocked(payReward).mockResolvedValueOnce(
      "0xfeed0000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    );

    const res = await submit(
      validPayload({ walletAddress: mixed, taskId: task.id, choice: "A" }),
    );
    expect(res.status).toBe(200);
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
});

describe("POST /api/submit - guards", () => {
  it("returns 403 banned for banned user", async () => {
    const wallet = makeWallet();
    await createUser({ walletAddress: wallet, isBanned: true });
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
    await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.submission.create({
      data: {
        walletAddress: wallet,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountWei: 0n,
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

    vi.mocked(payReward).mockResolvedValue(
      "0xfeed0000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    );

    vi.mocked(checkWalletRateLimit)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const first = await submit(validPayload({ walletAddress: wallet, taskId: task1.id }));
    expect(first.status).toBe(200);

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

    vi.mocked(payReward).mockResolvedValueOnce(
      "0xfeed0000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    );

    const res = await submit(
      validPayload({ walletAddress: wallet, taskId: gold.id, choice: "A" }),
    );
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.goldAttempted).toBe(1);
    expect(user?.goldCorrect).toBe(1);
  });

  it("bans user after 3 wrong gold answers (< 50% success)", async () => {
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
  });

  it("does not ban user when gold ratio >= 50%", async () => {
    const wallet = makeWallet();
    const gold1 = await createGoldTask("A");
    const gold2 = await createGoldTask("A");
    const gold3 = await createGoldTask("A");
    const gold4 = await createGoldTask("A");

    vi.mocked(payReward).mockResolvedValue(
      "0xfeed0000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    );

    await submit(validPayload({ walletAddress: wallet, taskId: gold1.id, choice: "A" }));
    await submit(validPayload({ walletAddress: wallet, taskId: gold2.id, choice: "A" }));
    await submit(validPayload({ walletAddress: wallet, taskId: gold3.id, choice: "B" }));
    await submit(validPayload({ walletAddress: wallet, taskId: gold4.id, choice: "A" }));

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.goldAttempted).toBe(4);
    expect(user?.goldCorrect).toBe(3);
    expect(user?.isBanned).toBe(false);
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

    vi.mocked(payReward).mockResolvedValueOnce(
      "0xfeed0000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    );

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/submit - payout", () => {
  it("returns paid:true with txHash on successful payout", async () => {
    const wallet = makeWallet();
    const task = await createTask();
    const txHash = "0xfeed0000000000000000000000000000000000000000000000000000000000";

    vi.mocked(payReward).mockResolvedValueOnce(txHash as `0x${string}`);

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paid).toBe(true);
    expect(body.txHash).toBe(txHash);
    expect(body.explorerUrl).toContain(txHash);

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: wallet, taskId: task.id },
    });
    expect(submission?.payoutStatus).toBe("sent");
    expect(submission?.payoutTxHash).toBe(txHash);

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.submissionCount).toBe(1);
    expect(user?.totalEarnedWei).toBeGreaterThan(0n);
  });

  it("returns 500 payout_failed when payReward throws and marks submission failed", async () => {
    const wallet = makeWallet();
    const task = await createTask();

    vi.mocked(payReward).mockRejectedValueOnce(new Error("RPC timeout"));

    const res = await submit(validPayload({ walletAddress: wallet, taskId: task.id, choice: "A" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("payout_failed");

    const submission = await prisma.submission.findFirst({
      where: { walletAddress: wallet, taskId: task.id },
    });
    expect(submission).not.toBeNull();
    expect(submission?.payoutStatus).toBe("failed");

    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    expect(user?.submissionCount).toBe(0);
  });
});
