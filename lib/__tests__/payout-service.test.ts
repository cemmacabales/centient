import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockPayReward, mockFindUnique, mockUserFindUnique, mockUserUpdate, mockExecuteRaw, mockTxUpdate, mockTxFindUnique } =
  vi.hoisted(() => ({
    mockPayReward: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockExecuteRaw: vi.fn(),
    mockTxUpdate: vi.fn(),
    mockTxFindUnique: vi.fn(),
  }));

const mockTx = {
  submission: {
    findUnique: mockTxFindUnique,
    update: mockTxUpdate,
  },
  user: {
    findUnique: mockUserFindUnique,
    update: mockUserUpdate,
  },
  $executeRaw: mockExecuteRaw,
};

vi.mock("@/lib/payout", () => ({
  payReward: mockPayReward,
  PayoutCapError: class extends Error {},
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    submission: { findUnique: mockFindUnique },
    $transaction: vi.fn((fn: any) => fn(mockTx)),
  },
}));

import { reprocessPayoutWithNonceSafety } from "../payout-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockTxFindUnique.mockResolvedValue(null);
  mockTxUpdate.mockResolvedValue({});
  mockUserFindUnique.mockResolvedValue(null);
  mockUserUpdate.mockResolvedValue({});
  mockExecuteRaw.mockResolvedValue(undefined);
  mockPayReward.mockReset();
});

describe("reprocessPayoutWithNonceSafety", () => {
  it("throws if submission is not found", async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    await expect(reprocessPayoutWithNonceSafety("missing-id")).rejects.toThrow(
      "Target submission record not found.",
    );
  });

  it("no-ops for confirmed status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-1",
      walletAddress: "0xaaa",
      payoutStatus: "confirmed",
      payoutAmountWei: 100n,
    });

    await reprocessPayoutWithNonceSafety("sub-1");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("no-ops for sent status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-2",
      walletAddress: "0xbbb",
      payoutStatus: "sent",
      payoutAmountWei: 200n,
    });

    await reprocessPayoutWithNonceSafety("sub-2");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("no-ops for skipped status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-3",
      walletAddress: "0xccc",
      payoutStatus: "skipped",
      payoutAmountWei: 0n,
    });

    await reprocessPayoutWithNonceSafety("sub-3");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("reprocesses failed submission successfully and credits user", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-4",
      walletAddress: "0xddd",
      payoutStatus: "failed",
      payoutAmountWei: 500n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-4",
      walletAddress: "0xddd",
      payoutStatus: "failed",
      payoutAmountWei: 500n,
      retryCount: 2,
    });

    mockPayReward.mockResolvedValueOnce("0xdeadbeef");

    mockUserFindUnique.mockResolvedValueOnce({
      submissionCount: 5,
      totalEarnedWei: 1000n,
    });

    await reprocessPayoutWithNonceSafety("sub-4");

    expect(mockExecuteRaw).toHaveBeenCalled();
    expect(mockPayReward).toHaveBeenCalledWith("0xddd", 500n);
    expect(mockTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-4" },
        data: expect.objectContaining({
          payoutStatus: "sent",
          payoutTxHash: "0xdeadbeef",
        }),
      }),
    );
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: "0xddd" },
        data: { submissionCount: 6, totalEarnedWei: 1500n },
      }),
    );
  });

  it("updates user totals for pending submissions on success", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-5",
      walletAddress: "0xeee",
      payoutStatus: "pending",
      payoutAmountWei: 700n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-5",
      walletAddress: "0xeee",
      payoutStatus: "pending",
      payoutAmountWei: 700n,
      retryCount: 0,
    });

    mockPayReward.mockResolvedValueOnce("0xcafe");

    mockUserFindUnique.mockResolvedValueOnce({
      submissionCount: 10,
      totalEarnedWei: 5000n,
    });

    await reprocessPayoutWithNonceSafety("sub-5");

    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: "0xeee" },
        data: { submissionCount: 11, totalEarnedWei: 5700n },
      }),
    );
  });

  it("marks as failed and increments retryCount on payout error", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-6",
      walletAddress: "0xfff",
      payoutStatus: "failed",
      payoutAmountWei: 300n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-6",
      walletAddress: "0xfff",
      payoutStatus: "failed",
      payoutAmountWei: 300n,
      retryCount: 1,
    });

    mockPayReward.mockRejectedValueOnce(new Error("RPC error"));

    await expect(reprocessPayoutWithNonceSafety("sub-6")).rejects.toThrow(
      "RPC error",
    );

    expect(mockTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-6" },
        data: expect.objectContaining({
          payoutStatus: "failed",
          retryCount: 2,
        }),
      }),
    );
  });

  it("double-checks status inside transaction to prevent double-payment", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-7",
      walletAddress: "0x111",
      payoutStatus: "failed",
      payoutAmountWei: 400n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-7",
      walletAddress: "0x111",
      payoutStatus: "sent",
      payoutAmountWei: 400n,
      retryCount: 0,
    });

    await reprocessPayoutWithNonceSafety("sub-7");

    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("acquires advisory lock on wallet address", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-8",
      walletAddress: "0x222",
      payoutStatus: "failed",
      payoutAmountWei: 600n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-8",
      walletAddress: "0x222",
      payoutStatus: "failed",
      payoutAmountWei: 600n,
      retryCount: 3,
    });

    mockPayReward.mockResolvedValueOnce("0x333");

    await reprocessPayoutWithNonceSafety("sub-8");

    expect(mockExecuteRaw).toHaveBeenCalled();
  });

  it("does not burn retryCount on PayoutCapError", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-9",
      walletAddress: "0x444",
      payoutStatus: "failed",
      payoutAmountWei: 100n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-9",
      walletAddress: "0x444",
      payoutStatus: "failed",
      payoutAmountWei: 100n,
      retryCount: 2,
      lastRetriedAt: new Date("2024-01-01"),
    });

    const CapError = class extends Error {
      name = "PayoutCapError";
    };
    mockPayReward.mockRejectedValueOnce(new CapError("Daily cap reached"));

    await reprocessPayoutWithNonceSafety("sub-9");

    expect(mockTxUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-9" },
        data: expect.objectContaining({
          payoutStatus: "pending",
          retryCount: 2,
        }),
      }),
    );
  });
});
