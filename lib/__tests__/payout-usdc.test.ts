import { vi, describe, it, expect, beforeEach } from "vitest";

// ST-3a (#295): payReward now settles a USDC payment via stellar/client.payUsdc.
// We mock the chain primitive (payUsdc) and the cap gate so these tests exercise
// payout.ts's orchestration — cap-before-send, hash pass-through, and surfacing
// the non-retryable op_no_trust / op_no_destination failures — without a network.

const { mockCheckPayoutCap, mockMaybeSendCapAlert, mockPayUsdc, mockGetTxStatus } =
  vi.hoisted(() => ({
    mockCheckPayoutCap: vi.fn(),
    mockMaybeSendCapAlert: vi.fn(),
    mockPayUsdc: vi.fn(),
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
  return {
    ...actual,
    payUsdc: mockPayUsdc,
    getTxStatus: mockGetTxStatus,
  };
});

import { payReward, waitForTx, PayoutCapError } from "../payout";
import { StellarPaymentError } from "../stellar/client";

const G_DEST = "GA7QYNF7SOWQ3GLR2BGMZEHHAVCQDZ7QF5K6X5K6X5K6X5K6X5K6X5K6";

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPayoutCap.mockResolvedValue({ allowed: true });
  mockMaybeSendCapAlert.mockResolvedValue(undefined);
});

describe("payReward → USDC payment", () => {
  it("settles via payUsdc and returns the Stellar transaction hash (a plain string, no 0x)", async () => {
    mockPayUsdc.mockResolvedValueOnce({ hash: "abc123def456" });

    const hash = await payReward(G_DEST, 5_000_000n);

    expect(mockPayUsdc).toHaveBeenCalledWith(G_DEST, 5_000_000n);
    expect(hash).toBe("abc123def456");
    expect(hash).not.toMatch(/^0x/);
  });

  it("enforces the daily cap before sending — propagates PayoutCapError and never broadcasts", async () => {
    mockCheckPayoutCap.mockRejectedValueOnce(new PayoutCapError(190n, 200n));

    await expect(payReward(G_DEST, 5_000_000n)).rejects.toBeInstanceOf(PayoutCapError);
    expect(mockPayUsdc).not.toHaveBeenCalled();
  });

  it("surfaces a non-retryable op_no_trust failure without looping", async () => {
    mockPayUsdc.mockRejectedValueOnce(
      new StellarPaymentError("no trustline", "op_no_trust", false),
    );

    await expect(payReward(G_DEST, 5_000_000n)).rejects.toMatchObject({
      code: "op_no_trust",
      retryable: false,
    });
    expect(mockPayUsdc).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-retryable op_no_destination failure without looping", async () => {
    mockPayUsdc.mockRejectedValueOnce(
      new StellarPaymentError("unfunded destination", "op_no_destination", false),
    );

    await expect(payReward(G_DEST, 5_000_000n)).rejects.toMatchObject({
      code: "op_no_destination",
      retryable: false,
    });
    expect(mockPayUsdc).toHaveBeenCalledTimes(1);
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
