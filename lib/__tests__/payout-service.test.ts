import { vi, describe, it, expect, beforeEach } from "vitest";

const {
  mockPayReward,
  mockFindUnique,
  mockSubmissionUpdate,
  mockUserFindUnique,
  mockUserUpdate,
  mockTxExecuteRaw,
  mockTxFindUnique,
} = vi.hoisted(() => ({
  mockPayReward: vi.fn(),
  mockFindUnique: vi.fn(),
  mockSubmissionUpdate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockTxExecuteRaw: vi.fn(),
  mockTxFindUnique: vi.fn(),
}));

// Transaction context — only used for the per-wallet advisory-lock re-check.
// The on-chain send and all post-send writes happen on the top-level client.
const mockTx = {
  submission: {
    findUnique: mockTxFindUnique,
  },
  $executeRaw: mockTxExecuteRaw,
};

vi.mock("@/lib/payout", () => ({
  payReward: mockPayReward,
  PayoutCapError: class extends Error {},
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    submission: { findUnique: mockFindUnique, update: mockSubmissionUpdate },
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
    $transaction: vi.fn((fn: any) => fn(mockTx)),
  },
}));

import { reprocessPayoutWithNonceSafety } from "../payout-service";

beforeEach(() => {
  vi.clearAllMocks();
  mockTxFindUnique.mockResolvedValue(null);
  mockSubmissionUpdate.mockResolvedValue({});
  mockUserFindUnique.mockResolvedValue(null);
  mockUserUpdate.mockResolvedValue({});
  mockTxExecuteRaw.mockResolvedValue(undefined);
  mockPayReward.mockReset();
});

describe("reprocessPayoutWithNonceSafety", () => {
  it("throws if submission is not found", async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    await expect(reprocessPayoutWithNonceSafety("missing-id")).rejects.toThrow(
      "Target submission record not found.",
    );
  });

  it("throws when submission vanishes between initial check and claim transaction", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-vanish",
      walletAddress: "0xvvv",
      payoutStatus: "failed",
      payoutAmountUnits: 100n,
    });
    // Submission deleted after the initial check but before the advisory lock re-check
    mockTxFindUnique.mockResolvedValueOnce(null);

    await expect(reprocessPayoutWithNonceSafety("sub-vanish")).rejects.toThrow(
      "Submission vanished during retry.",
    );
  });

  it("no-ops for confirmed status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-1",
      walletAddress: "0xaaa",
      payoutStatus: "confirmed",
      payoutAmountUnits: 100n,
    });

    await reprocessPayoutWithNonceSafety("sub-1");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("no-ops for sent status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-2",
      walletAddress: "0xbbb",
      payoutStatus: "sent",
      payoutAmountUnits: 200n,
    });

    await reprocessPayoutWithNonceSafety("sub-2");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("no-ops for skipped status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-3",
      walletAddress: "0xccc",
      payoutStatus: "skipped",
      payoutAmountUnits: 0n,
    });

    await reprocessPayoutWithNonceSafety("sub-3");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("reprocesses failed submission successfully and credits user", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-4",
      walletAddress: "0xddd",
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-4",
      walletAddress: "0xddd",
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
      payoutTxHash: null,
      retryCount: 2,
    });

    mockPayReward.mockResolvedValueOnce("0xdeadbeef");

    mockUserFindUnique.mockResolvedValueOnce({
      submissionCount: 5,
      totalEarnedUnits: 1000n,
    });

    await reprocessPayoutWithNonceSafety("sub-4");

    expect(mockTxExecuteRaw).toHaveBeenCalled();
    expect(mockPayReward).toHaveBeenCalledWith("0xddd", 500n);
    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
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
        data: { submissionCount: 6, totalEarnedUnits: 1500n },
      }),
    );
  });

  it("updates user totals for pending submissions on success", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-5",
      walletAddress: "0xeee",
      payoutStatus: "pending",
      payoutAmountUnits: 700n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-5",
      walletAddress: "0xeee",
      payoutStatus: "pending",
      payoutAmountUnits: 700n,
      payoutTxHash: null,
      retryCount: 0,
    });

    mockPayReward.mockResolvedValueOnce("0xcafe");

    mockUserFindUnique.mockResolvedValueOnce({
      submissionCount: 10,
      totalEarnedUnits: 5000n,
    });

    await reprocessPayoutWithNonceSafety("sub-5");

    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: "0xeee" },
        data: { submissionCount: 11, totalEarnedUnits: 5700n },
      }),
    );
  });

  it("does not re-broadcast when a txHash is already persisted", async () => {
    // Simulates the state left by an admin-catch rollback that overwrote "sent"
    // back to "failed" while leaving payoutTxHash set — claimForRetry must bail.
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-4b",
      walletAddress: "0xd2d",
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-4b",
      walletAddress: "0xd2d",
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
      payoutTxHash: "0xprevious",
      retryCount: 1,
    });

    await reprocessPayoutWithNonceSafety("sub-4b");

    expect(mockPayReward).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("marks as failed and increments retryCount on payout error", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-6",
      walletAddress: "0xfff",
      payoutStatus: "failed",
      payoutAmountUnits: 300n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-6",
      walletAddress: "0xfff",
      payoutStatus: "failed",
      payoutAmountUnits: 300n,
      payoutTxHash: null,
      retryCount: 1,
    });

    mockPayReward.mockRejectedValueOnce(new Error("RPC error"));

    await expect(reprocessPayoutWithNonceSafety("sub-6")).rejects.toThrow(
      "RPC error",
    );

    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-6" },
        data: expect.objectContaining({
          payoutStatus: "failed",
          retryCount: 2,
        }),
      }),
    );
  });

  it("double-checks status under the advisory lock to prevent double-payment", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-7",
      walletAddress: "0x111",
      payoutStatus: "failed",
      payoutAmountUnits: 400n,
    });

    // Another worker already advanced it to "sent" by the time we hold the lock.
    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-7",
      walletAddress: "0x111",
      payoutStatus: "sent",
      payoutAmountUnits: 400n,
      payoutTxHash: "0xother",
      retryCount: 0,
    });

    await reprocessPayoutWithNonceSafety("sub-7");

    expect(mockPayReward).not.toHaveBeenCalled();
    expect(mockSubmissionUpdate).not.toHaveBeenCalled();
  });

  it("acquires advisory lock on wallet address", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-8",
      walletAddress: "0x222",
      payoutStatus: "failed",
      payoutAmountUnits: 600n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-8",
      walletAddress: "0x222",
      payoutStatus: "failed",
      payoutAmountUnits: 600n,
      payoutTxHash: null,
      retryCount: 3,
    });

    mockPayReward.mockResolvedValueOnce("0x333");

    await reprocessPayoutWithNonceSafety("sub-8");

    expect(mockTxExecuteRaw).toHaveBeenCalled();
  });

  it("does not broadcast inside a rolling-back transaction (payReward runs after commit)", async () => {
    // The claim transaction must resolve before payReward is ever called, so a
    // post-send DB failure can never roll back the persisted txHash.
    const callOrder: string[] = [];

    mockFindUnique.mockResolvedValueOnce({
      id: "sub-order",
      walletAddress: "0x999",
      payoutStatus: "failed",
      payoutAmountUnits: 100n,
    });
    mockTxExecuteRaw.mockImplementationOnce(async () => {
      callOrder.push("lock");
    });
    mockTxFindUnique.mockImplementationOnce(async () => {
      callOrder.push("recheck");
      return {
        id: "sub-order",
        walletAddress: "0x999",
        payoutStatus: "failed",
        payoutAmountUnits: 100n,
        payoutTxHash: null,
        retryCount: 0,
      };
    });
    mockPayReward.mockImplementationOnce(async () => {
      callOrder.push("payReward");
      return "0xabc";
    });

    await reprocessPayoutWithNonceSafety("sub-order");

    expect(callOrder).toEqual(["lock", "recheck", "payReward"]);
  });

  it("does not burn retryCount on PayoutCapError", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-9",
      walletAddress: "0x444",
      payoutStatus: "failed",
      payoutAmountUnits: 100n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-9",
      walletAddress: "0x444",
      payoutStatus: "failed",
      payoutAmountUnits: 100n,
      payoutTxHash: null,
      retryCount: 2,
      lastRetriedAt: new Date("2024-01-01"),
    });

    const CapError = class extends Error {
      name = "PayoutCapError";
    };
    mockPayReward.mockRejectedValueOnce(new CapError("Daily cap reached"));

    await reprocessPayoutWithNonceSafety("sub-9");

    // Status reset to pending, retryCount left untouched (no increment).
    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-9" },
        data: { payoutStatus: "pending" },
      }),
    );
    expect(mockSubmissionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payoutStatus: "failed" }),
      }),
    );
  });
});
