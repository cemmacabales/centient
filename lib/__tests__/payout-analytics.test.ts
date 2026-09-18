import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Every on-chain payout attempt is recorded in PostHog under the recipient
// wallet: address, amount, hash, and whether it settled. The payout itself must
// not depend on analytics, so a throwing client cannot fail a payment.

const { mockCapture, mockSubmitMultisigPayout, mockResolveCoSigner } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
  mockSubmitMultisigPayout: vi.fn(),
  mockResolveCoSigner: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function () {
    return { capture: mockCapture };
  }),
}));

vi.mock("../payout-cap", async (importActual) => {
  const actual = await importActual<typeof import("../payout-cap")>();
  return { ...actual, checkPayoutCap: vi.fn().mockResolvedValue({ allowed: true }), maybeSendCapAlert: vi.fn() };
});

vi.mock("../stellar/payout-submitter", async (importActual) => {
  const actual = await importActual<typeof import("../stellar/payout-submitter")>();
  return { ...actual, submitMultisigPayout: mockSubmitMultisigPayout };
});

vi.mock("../stellar/payout-cosigner", async (importActual) => {
  const actual = await importActual<typeof import("../stellar/payout-cosigner")>();
  return { ...actual, resolvePayoutCoSigner: mockResolveCoSigner };
});

import { payReward } from "../payout";
import { PAYOUT_TRANSACTION_EVENT, resetAnalyticsClientForTests } from "../payout-analytics";
import { StellarPaymentError } from "../stellar/client";

const G_DEST = "GA7QYNF7SOWQ3GLR2BGMZEHHAVCQDZ7QF5K6X5K6X5K6X5K6X5K6X5K6";
const HASH = "a".repeat(64);
const reference = { kind: "payout_job", id: "job-1" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  resetAnalyticsClientForTests();
  mockResolveCoSigner.mockReturnValue({ signPayout: vi.fn() });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAnalyticsClientForTests();
});

describe("payReward → PostHog payout_transaction", () => {
  it("records a settled payout under the wallet with amount and hash", async () => {
    mockSubmitMultisigPayout.mockResolvedValueOnce({ hash: HASH });

    await payReward(G_DEST, 2_500_000n, reference);

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: G_DEST,
      event: PAYOUT_TRANSACTION_EVENT,
      properties: {
        wallet_address: G_DEST,
        amount_usdc: 0.25,
        amount_units: "2500000",
        tx_hash: HASH,
        success: true,
        status: "success",
        error_code: null,
        reference_kind: "payout_job",
        reference_id: "job-1",
      },
    });
  });

  it("records a failed payout with its error code and the hash the error names", async () => {
    mockSubmitMultisigPayout.mockRejectedValueOnce(
      new StellarPaymentError(`transaction ${HASH} was included and failed`, "tx_failed", false),
    );

    await expect(payReward(G_DEST, 2_500_000n, reference)).rejects.toBeInstanceOf(StellarPaymentError);

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          tx_hash: HASH,
          success: false,
          status: "failed",
          error_code: "tx_failed",
        }),
      }),
    );
  });

  it("records a null hash when the failure never produced one", async () => {
    mockSubmitMultisigPayout.mockRejectedValueOnce(new StellarPaymentError("no trustline", "op_no_trust", false));

    await expect(payReward(G_DEST, 1n, reference)).rejects.toThrow();

    expect(mockCapture.mock.calls[0][0].properties).toMatchObject({ tx_hash: null, error_code: "op_no_trust" });
  });

  it("never lets a throwing analytics client fail the payout", async () => {
    mockCapture.mockImplementationOnce(() => {
      throw new Error("posthog down");
    });
    mockSubmitMultisigPayout.mockResolvedValueOnce({ hash: HASH });

    await expect(payReward(G_DEST, 1n, reference)).resolves.toBe(HASH);
  });

  it("captures nothing when no PostHog key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    resetAnalyticsClientForTests();
    mockSubmitMultisigPayout.mockResolvedValueOnce({ hash: HASH });

    await payReward(G_DEST, 1n, reference);

    expect(mockCapture).not.toHaveBeenCalled();
  });
});
