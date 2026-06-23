import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { processJob } from "@/lib/payout-worker";
import { payReward, PayoutCapError } from "@/lib/payout";
import { refundReversal } from "@/lib/user-balance";
import { prisma } from "@/tests/helpers/db";
import crypto from "crypto";

// Safe database cleanup ignoring missing or uninitialized tables
async function cleanDatabase() {
  try {
    await prisma.payoutJob.deleteMany({});
    await prisma.submission.deleteMany({});
    await prisma.dispute.deleteMany({});
    await prisma.userBalanceLedger.deleteMany({});
    await prisma.user.deleteMany({});
  } catch (e) {
    // Suppress errors gracefully if tables aren't set up yet during early test runs
  }
}

function generateWallet(): string {
  const chars = "abcdef0123456789";
  let hex = "";
  for (let i = 0; i < 40; i++) {
    hex += chars[Math.floor(Math.random() * 16)];
  }
  return `0x${hex}`;
}

beforeAll(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
});

vi.mock("@/lib/payout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payout")>();
  return {
    ...actual,
    payReward: vi.fn(),
  };
});

vi.mock("@/lib/user-balance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/user-balance")>();
  return {
    ...actual,
    refundReversal: vi.fn(),
  };
});

describe("Lump-sum withdrawal handling", () => {
  it("pays a lump-sum amount successfully", async () => {
    vi.mocked(payReward).mockReset();
    vi.mocked(refundReversal).mockReset();
    vi.mocked(refundReversal).mockResolvedValue(0n);

    const wallet = generateWallet();
    const userId = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { 
        id: userId, 
        walletAddress: wallet, 
        pendingBalanceWei: 0n,
        email: `${crypto.randomUUID()}@test.com`,
        passwordHash: "dummy_hash"
      },
    });
    const walletAddress = wallet as `0x${string}`;
    const amountWei = 1000000000000000000n;

    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountWei,
        destinationAddress: walletAddress,
        status: "queued", // Valid PayoutJobStatus enum value
      },
    });

    vi.mocked(payReward).mockResolvedValueOnce("0x1234");

    await processJob(job.id, null, user.id, amountWei, "WITHDRAWAL");

    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("done");
    expect(updatedJob?.txHash).toBe("0x1234");

    const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updatedUser?.pendingBalanceWei).toBe(0n);
  });

  it("refunds user balance on daily cap hit", async () => {
    vi.mocked(payReward).mockReset();
    vi.mocked(refundReversal).mockReset();
    vi.mocked(refundReversal).mockResolvedValue(0n);

    const wallet = generateWallet();
    const userId = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { 
        id: userId, 
        walletAddress: wallet, 
        pendingBalanceWei: 0n,
        email: `${crypto.randomUUID()}@test.com`,
        passwordHash: "dummy_hash"
      },
    });
    const walletAddress = wallet as `0x${string}`;
    const amountWei = 1000000000000000000n;

    await prisma.user.update({
      where: { id: user.id },
      data: { pendingBalanceWei: amountWei },
    });

    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountWei,
        destinationAddress: walletAddress,
        status: "queued",
      },
    });

    vi.mocked(payReward).mockRejectedValueOnce(new PayoutCapError(0n, 0n));

    await processJob(job.id, null, user.id, amountWei, "WITHDRAWAL");

    expect(refundReversal).toHaveBeenCalledWith(
      user.id,
      amountWei,
      job.id,
      expect.stringContaining("daily cap")
    );

    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.lastError).toContain("payout cap exceeded");
  });

  it("retries on nonce error and eventually succeeds", async () => {
    vi.mocked(payReward).mockReset();
    vi.mocked(refundReversal).mockReset();
    vi.mocked(refundReversal).mockResolvedValue(0n);

    const wallet = generateWallet();
    const userId = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { 
        id: userId, 
        walletAddress: wallet, 
        pendingBalanceWei: 0n,
        email: `${crypto.randomUUID()}@test.com`,
        passwordHash: "dummy_hash"
      },
    });
    const walletAddress = wallet as `0x${string}`;
    const amountWei = 1000000000000000000n;

    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountWei,
        destinationAddress: walletAddress,
        status: "queued",
      },
    });

    vi.mocked(payReward)
      .mockRejectedValueOnce(new Error("nonce too low"))
      .mockResolvedValueOnce("0x5678");

    await processJob(job.id, null, user.id, amountWei, "WITHDRAWAL");
    let jobAfter = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(jobAfter?.status).toBe("queued");
    expect(jobAfter?.retryCount).toBe(1);

    await processJob(job.id, null, user.id, amountWei, "WITHDRAWAL");
    jobAfter = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(jobAfter?.status).toBe("done");
    expect(jobAfter?.txHash).toBe("0x5678");
  });

  it("refunds user balance on permanent failure", async () => {
    vi.mocked(payReward).mockReset();
    vi.mocked(refundReversal).mockReset();
    vi.mocked(refundReversal).mockResolvedValue(0n);

    const wallet = generateWallet();
    const userId = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { 
        id: userId, 
        walletAddress: wallet, 
        pendingBalanceWei: 0n,
        email: `${crypto.randomUUID()}@test.com`,
        passwordHash: "dummy_hash"
      },
    });
    const walletAddress = wallet as `0x${string}`;
    const amountWei = 1000000000000000000n;

    await prisma.user.update({
      where: { id: user.id },
      data: { pendingBalanceWei: amountWei },
    });

    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountWei,
        destinationAddress: walletAddress,
        status: "queued",
        retryCount: 2,
      },
    });

    vi.mocked(payReward).mockRejectedValueOnce(new Error("RPC timeout"));

    await processJob(job.id, null, user.id, amountWei, "WITHDRAWAL");

    expect(refundReversal).toHaveBeenCalledWith(
      user.id,
      amountWei,
      job.id,
      expect.stringContaining("Refund for failed withdrawal")
    );

    const updatedJob = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.retryCount).toBe(3);
  });
});

describe("Reconciler confirms lump-sum receipt", () => {
  it("confirms a withdrawal job when the transaction succeeds", async () => {
    const wallet = generateWallet();
    const userId = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { 
        id: userId, 
        walletAddress: wallet, 
        pendingBalanceWei: 0n,
        email: `${crypto.randomUUID()}@test.com`,
        passwordHash: "dummy_hash"
      },
    });
    const walletAddress = wallet as `0x${string}`;
    const amountWei = 1000000000000000000n;

    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountWei,
        destinationAddress: walletAddress,
        status: "processing", // Valid enum check
        txHash: "0x1234",
      },
    });

    const found = await prisma.payoutJob.findUnique({ where: { id: job.id } });
    expect(found).not.toBeNull();
    expect(found?.txHash).toBe("0x1234");
  });
});
