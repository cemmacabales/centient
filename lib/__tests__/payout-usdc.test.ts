import { vi, describe, it, expect, beforeEach } from "vitest";

// E1-3 (#7): payReward settles through the multisig payout service — build,
// platform-sign, independent co-sign, fee-bump, submit — replacing the
// single-key stellar/client.payUsdc broadcast. We mock the submitter and the
// co-signer resolver so these tests exercise payout.ts's orchestration
// (cap-before-send, reference pass-through, hash pass-through, and surfacing the
// non-retryable op_no_trust / op_no_destination failures) without a network.

const {
  mockCheckPayoutCap,
  mockMaybeSendCapAlert,
  mockSubmitMultisigPayout,
  mockResolveCoSigner,
  mockGetTxStatus,
} = vi.hoisted(() => ({
  mockCheckPayoutCap: vi.fn(),
  mockMaybeSendCapAlert: vi.fn(),
  mockSubmitMultisigPayout: vi.fn(),
  mockResolveCoSigner: vi.fn(),
  mockGetTxStatus: vi.fn(),
}));

vi.mock("../payout-cap", async (importActual) => {
  const actual = await importActual<typeof import("../payout-cap")>();
  return {
    ...actual,
    checkPayoutCap: mockCheckPayoutCap,
    maybeSendCapAlert: mockMaybeSendCapAlert,
  };
});

vi.mock("../stellar/client", async (importActual) => {
  const actual = await importActual<typeof import("../stellar/client")>();
  return { ...actual, getTxStatus: mockGetTxStatus };
});

vi.mock("../stellar/payout-submitter", async (importActual) => {
  const actual = await importActual<typeof import("../stellar/payout-submitter")>();
  return { ...actual, submitMultisigPayout: mockSubmitMultisigPayout };
});

vi.mock("../stellar/payout-cosigner", async (importActual) => {
  const actual = await importActual<typeof import("../stellar/payout-cosigner")>();
  return { ...actual, resolvePayoutCoSigner: mockResolveCoSigner };
});

import { payReward, waitForTx, PayoutCapError } from "../payout";
import { StellarPaymentError } from "../stellar/client";

const G_DEST = "GA7QYNF7SOWQ3GLR2BGMZEHHAVCQDZ7QF5K6X5K6X5K6X5K6X5K6X5K6";
const reference = { kind: "submission", id: "sub-1" } as const;
const coSigner = { signPayout: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPayoutCap.mockResolvedValue({ allowed: true });
  mockMaybeSendCapAlert.mockResolvedValue(undefined);
  mockResolveCoSigner.mockReturnValue(coSigner);
});

describe("payReward → multisig USDC payout", () => {
  it("settles through the multisig submitter and returns the Stellar hash", async () => {
    mockSubmitMultisigPayout.mockResolvedValueOnce({ hash: "abc123def456" });

    const hash = await payReward(G_DEST, 5_000_000n, reference);

    expect(mockSubmitMultisigPayout).toHaveBeenCalledWith(
      { destination: G_DEST, amountUnits: 5_000_000n, reference },
      expect.objectContaining({ coSigner }),
    );
    expect(hash).toBe("abc123def456");
    expect(hash).not.toMatch(/^0x/);
  });

  it("has no single-key broadcast to fall back to", async () => {
    // #7's DoD: no code path can submit a payout with one signature. That holds
    // by construction only if the single-key submit no longer exists.
    const client = await vi.importActual<Record<string, unknown>>("../stellar/client");
    expect(client).not.toHaveProperty("payUsdc");
  });

  it("carries the payout reference through so the co-signer can re-derive it", async () => {
    mockSubmitMultisigPayout.mockResolvedValueOnce({ hash: "h" });
    const jobReference = { kind: "payout_job", id: "job-9" } as const;

    await payReward(G_DEST, 5_000_000n, jobReference);

    expect(mockSubmitMultisigPayout).toHaveBeenCalledWith(
      expect.objectContaining({ reference: jobReference }),
      expect.anything(),
    );
  });

  it("enforces the daily cap before sending — propagates PayoutCapError and never broadcasts", async () => {
    mockCheckPayoutCap.mockRejectedValueOnce(new PayoutCapError(190n, 200n));

    await expect(payReward(G_DEST, 5_000_000n, reference)).rejects.toBeInstanceOf(
      PayoutCapError,
    );
    expect(mockSubmitMultisigPayout).not.toHaveBeenCalled();
  });

  it("refuses to broadcast when no co-signer is configured", async () => {
    mockResolveCoSigner.mockImplementationOnce(() => {
      throw new Error("no payout co-signer is configured");
    });

    await expect(payReward(G_DEST, 5_000_000n, reference)).rejects.toThrow(
      /no payout co-signer is configured/,
    );
    expect(mockSubmitMultisigPayout).not.toHaveBeenCalled();
  });

  it("surfaces a non-retryable op_no_trust failure without looping", async () => {
    mockSubmitMultisigPayout.mockRejectedValueOnce(
      new StellarPaymentError("no trustline", "op_no_trust", false),
    );

    await expect(payReward(G_DEST, 5_000_000n, reference)).rejects.toMatchObject({
      code: "op_no_trust",
      retryable: false,
    });
    expect(mockSubmitMultisigPayout).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-retryable op_no_destination failure without looping", async () => {
    mockSubmitMultisigPayout.mockRejectedValueOnce(
      new StellarPaymentError("unfunded destination", "op_no_destination", false),
    );

    await expect(payReward(G_DEST, 5_000_000n, reference)).rejects.toMatchObject({
      code: "op_no_destination",
      retryable: false,
    });
    expect(mockSubmitMultisigPayout).toHaveBeenCalledTimes(1);
  });
});

describe("waitForTx → Horizon status", () => {
  it("maps a confirmed transaction to success", async () => {
    mockGetTxStatus.mockResolvedValueOnce("confirmed");

    const receipt = await waitForTx("hash-confirmed");

    expect(receipt).toEqual({ status: "success", transactionHash: "hash-confirmed" });
  });

  it("maps an explicitly failed transaction to reverted", async () => {
    mockGetTxStatus.mockResolvedValueOnce("failed");

    const receipt = await waitForTx("hash-failed");

    expect(receipt.status).toBe("reverted");
  });

  it("throws a timeout-shaped error when the transaction is not yet visible", async () => {
    mockGetTxStatus.mockResolvedValueOnce("not_found");

    await expect(waitForTx("hash-pending")).rejects.toThrow(/timed out/);
  });
});
