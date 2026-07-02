import { vi, describe, it, expect, beforeEach } from "vitest";
import { StellarPaymentError } from "../stellar/client";

// Stellar `G…` StrKey destinations (case-sensitive base32) and bare-hex tx
// hashes — the rail returns plain `string` hashes, not EVM `0x…` (ST-3d #298).
const G_A = "GCKIPQX2TEZWBQSUPPNMKGJBODL246B374Y52SPD2OGJ2AAQ6SHYUR6E";
const G_B = "GDPOQHA3CVVJD3IJTCRHQ2KYVZA6LH5KY6NHHZWDF6A5L4IJXZSWCOZI";
const G_C = "GAMKKZ27XVGL4TTGPUWZGI6TUBLDUH4T5JCWDCXK3KSSPTWQI47TLAQL";
const G_D = "GDYHJM2WZTBWJFLJM6VKPF35I7Y4527UIWDOS3U77NGH3EJHKGXCFNKC";
const G_E = "GBVWPA44JNPUEO4IJSNZ5SQASS6E3Q6JNFH2NCOS4KVS4GJQHADCYHBE";
const G_F = "GCFQ7O5PHNN27T7GY7U6ANYITDTCZZGBZMGZNBBKNG6HW33FU3RWJJ6Q";

const TX_1 = "78fb091c63b85385bde46501fcea135bfd7b540deeecd524d7b63408fcb16173";
const TX_2 = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const TX_3 = "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd";
const TX_OTHER = "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";

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

  it("marks failed (no send) when the destination is not a valid StrKey", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-bad-addr",
      // legacy EVM `0x…` address — invalid on Stellar, can never be paid.
      walletAddress: "0xnot-a-strkey",
      payoutStatus: "failed",
      payoutAmountUnits: 100n,
    });

    await expect(
      reprocessPayoutWithNonceSafety("sub-bad-addr"),
    ).rejects.toThrow(/no payable Stellar address/);

    expect(mockPayReward).not.toHaveBeenCalled();
    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-bad-addr" },
        data: expect.objectContaining({ payoutStatus: "failed" }),
      }),
    );
  });

  it("marks failed (no send) when the submission has no linked wallet (ST-5d)", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-no-wallet",
      // Email-only answerer — no wallet was ever linked, so nothing to pay on-chain.
      walletAddress: null,
      payoutStatus: "pending",
      payoutAmountUnits: 100n,
    });

    await expect(
      reprocessPayoutWithNonceSafety("sub-no-wallet"),
    ).rejects.toThrow(/no payable Stellar address/);

    expect(mockPayReward).not.toHaveBeenCalled();
    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-no-wallet" },
        data: expect.objectContaining({ payoutStatus: "failed" }),
      }),
    );
  });

  it("throws when submission vanishes between initial check and claim transaction", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-vanish",
      walletAddress: G_A,
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
      walletAddress: G_A,
      payoutStatus: "confirmed",
      payoutAmountUnits: 100n,
    });

    await reprocessPayoutWithNonceSafety("sub-1");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("no-ops for sent status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-2",
      walletAddress: G_A,
      payoutStatus: "sent",
      payoutAmountUnits: 200n,
    });

    await reprocessPayoutWithNonceSafety("sub-2");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("no-ops for skipped status", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-3",
      walletAddress: G_A,
      payoutStatus: "skipped",
      payoutAmountUnits: 0n,
    });

    await reprocessPayoutWithNonceSafety("sub-3");
    expect(mockPayReward).not.toHaveBeenCalled();
  });

  it("reprocesses failed submission successfully and credits user", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-4",
      walletAddress: G_B,
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-4",
      walletAddress: G_B,
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
      payoutTxHash: null,
      retryCount: 2,
    });

    mockPayReward.mockResolvedValueOnce(TX_1);

    mockUserFindUnique.mockResolvedValueOnce({
      submissionCount: 5,
      totalEarnedUnits: 1000n,
    });

    await reprocessPayoutWithNonceSafety("sub-4");

    expect(mockTxExecuteRaw).toHaveBeenCalled();
    expect(mockPayReward).toHaveBeenCalledWith(G_B, 500n);
    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-4" },
        data: expect.objectContaining({
          payoutStatus: "sent",
          payoutTxHash: TX_1,
        }),
      }),
    );
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: G_B },
        data: { submissionCount: 6, totalEarnedUnits: 1500n },
      }),
    );
  });

  it("updates user totals for pending submissions on success", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-5",
      walletAddress: G_C,
      payoutStatus: "pending",
      payoutAmountUnits: 700n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-5",
      walletAddress: G_C,
      payoutStatus: "pending",
      payoutAmountUnits: 700n,
      payoutTxHash: null,
      retryCount: 0,
    });

    mockPayReward.mockResolvedValueOnce(TX_2);

    mockUserFindUnique.mockResolvedValueOnce({
      submissionCount: 10,
      totalEarnedUnits: 5000n,
    });

    await reprocessPayoutWithNonceSafety("sub-5");

    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: G_C },
        data: { submissionCount: 11, totalEarnedUnits: 5700n },
      }),
    );
  });

  it("does not re-broadcast when a txHash is already persisted", async () => {
    // Simulates the state left by an admin-catch rollback that overwrote "sent"
    // back to "failed" while leaving payoutTxHash set — claimForRetry must bail.
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-4b",
      walletAddress: G_D,
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-4b",
      walletAddress: G_D,
      payoutStatus: "failed",
      payoutAmountUnits: 500n,
      payoutTxHash: TX_OTHER,
      retryCount: 1,
    });

    await reprocessPayoutWithNonceSafety("sub-4b");

    expect(mockPayReward).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("marks as failed and increments retryCount on payout error", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-6",
      walletAddress: G_E,
      payoutStatus: "failed",
      payoutAmountUnits: 300n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-6",
      walletAddress: G_E,
      payoutStatus: "failed",
      payoutAmountUnits: 300n,
      payoutTxHash: null,
      retryCount: 1,
    });

    mockPayReward.mockRejectedValueOnce(new Error("Horizon error"));

    await expect(reprocessPayoutWithNonceSafety("sub-6")).rejects.toThrow(
      "Horizon error",
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

  it("surfaces a non-retryable op_no_trust as a payout failure", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-trust",
      walletAddress: G_F,
      payoutStatus: "failed",
      payoutAmountUnits: 300n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-trust",
      walletAddress: G_F,
      payoutStatus: "failed",
      payoutAmountUnits: 300n,
      payoutTxHash: null,
      retryCount: 0,
    });

    mockPayReward.mockRejectedValueOnce(
      new StellarPaymentError(
        `payUsdc: destination ${G_F} has no USDC trustline (op_no_trust)`,
        "op_no_trust",
        false,
      ),
    );

    await expect(reprocessPayoutWithNonceSafety("sub-trust")).rejects.toThrow(
      /op_no_trust/,
    );

    expect(mockSubmissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-trust" },
        data: expect.objectContaining({ payoutStatus: "failed" }),
      }),
    );
  });

  it("double-checks status under the advisory lock to prevent double-payment", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-7",
      walletAddress: G_A,
      payoutStatus: "failed",
      payoutAmountUnits: 400n,
    });

    // Another worker already advanced it to "sent" by the time we hold the lock.
    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-7",
      walletAddress: G_A,
      payoutStatus: "sent",
      payoutAmountUnits: 400n,
      payoutTxHash: TX_OTHER,
      retryCount: 0,
    });

    await reprocessPayoutWithNonceSafety("sub-7");

    expect(mockPayReward).not.toHaveBeenCalled();
    expect(mockSubmissionUpdate).not.toHaveBeenCalled();
  });

  it("acquires advisory lock on wallet address", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-8",
      walletAddress: G_F,
      payoutStatus: "failed",
      payoutAmountUnits: 600n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-8",
      walletAddress: G_F,
      payoutStatus: "failed",
      payoutAmountUnits: 600n,
      payoutTxHash: null,
      retryCount: 3,
    });

    mockPayReward.mockResolvedValueOnce(TX_3);

    await reprocessPayoutWithNonceSafety("sub-8");

    expect(mockTxExecuteRaw).toHaveBeenCalled();
  });

  it("does not broadcast inside a rolling-back transaction (payReward runs after commit)", async () => {
    // The claim transaction must resolve before payReward is ever called, so a
    // post-send DB failure can never roll back the persisted txHash.
    const callOrder: string[] = [];

    mockFindUnique.mockResolvedValueOnce({
      id: "sub-order",
      walletAddress: G_B,
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
        walletAddress: G_B,
        payoutStatus: "failed",
        payoutAmountUnits: 100n,
        payoutTxHash: null,
        retryCount: 0,
      };
    });
    mockPayReward.mockImplementationOnce(async () => {
      callOrder.push("payReward");
      return TX_1;
    });

    await reprocessPayoutWithNonceSafety("sub-order");

    expect(callOrder).toEqual(["lock", "recheck", "payReward"]);
  });

  it("does not burn retryCount on PayoutCapError", async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: "sub-9",
      walletAddress: G_C,
      payoutStatus: "failed",
      payoutAmountUnits: 100n,
    });

    mockTxFindUnique.mockResolvedValueOnce({
      id: "sub-9",
      walletAddress: G_C,
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
