import { Asset, Keypair } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// #40: the one place a `sent` submission is settled against Horizon. These
// tests mock Horizon's `lookupTx` ("confirmed" | "failed" | "not_found", with
// the envelope once included) and the envelope verifier, and assert what each
// answer, or a read that throws, does to the row.
const { mockLookupTx, mockVerify, mockSubFindUnique, mockSubUpdate, mockSubUpdateMany } = vi.hoisted(() => ({
  mockLookupTx: vi.fn(),
  mockVerify: vi.fn(),
  mockSubFindUnique: vi.fn(),
  mockSubUpdate: vi.fn(),
  mockSubUpdateMany: vi.fn(),
}));

const USDC = new Asset("USDC", Keypair.random().publicKey());
const PAYOUT_ACCOUNT = Keypair.random().publicKey();
const WALLET = Keypair.random().publicKey();

// getTxStatus and latestLedgerCloseMs are read when #38's attempts module
// loads; nothing here calls them.
vi.mock("@/lib/stellar/client", () => ({
  lookupTx: mockLookupTx,
  getTxStatus: vi.fn(),
  latestLedgerCloseMs: vi.fn(),
}));
vi.mock("@/lib/stellar/payout-verify", () => ({ verifySettledPayout: mockVerify }));
vi.mock("@/lib/stellar/config", () => ({ usdcAsset: () => USDC }));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    submission: { findUnique: mockSubFindUnique, update: mockSubUpdate, updateMany: mockSubUpdateMany },
  },
}));

import { reconcileSubmission } from "../payout-reconcile";
import * as Sentry from "@sentry/nextjs";

const TX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const CONFIRMED = { status: "confirmed", envelopeXdr: "ENVELOPE" } as const;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, STELLAR_PLATFORM_ACCOUNT: PAYOUT_ACCOUNT };
  mockSubUpdate.mockResolvedValue({});
  mockSubUpdateMany.mockResolvedValue({ count: 1 });
  mockSubFindUnique.mockResolvedValue({ walletAddress: WALLET, payoutAmountUnits: 2_500_000n });
  mockVerify.mockReturnValue({ ok: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** The single status write for this row — always conditional on it still being `sent` under TX. */
function statusWrite(id: string) {
  const calls = mockSubUpdateMany.mock.calls.filter(([arg]) => arg.data.payoutStatus !== undefined);
  expect(calls).toHaveLength(1);
  expect(calls[0][0].where).toEqual({ id, payoutStatus: "sent", payoutTxHash: TX });
  return calls[0][0].data;
}

describe("reconcileSubmission", () => {
  it("confirms a payout whose envelope pays the submission", async () => {
    mockLookupTx.mockResolvedValueOnce(CONFIRMED);

    await reconcileSubmission("sub-1", TX);

    expect(mockLookupTx).toHaveBeenCalledWith(TX);
    expect(mockVerify).toHaveBeenCalledWith("ENVELOPE", {
      payoutAccount: PAYOUT_ACCOUNT,
      destination: WALLET,
      amountUnits: 2_500_000n,
      asset: USDC,
    });
    expect(statusWrite("sub-1")).toMatchObject({ payoutStatus: "confirmed" });
  });

  it("leaves the submission untouched (still pending) on not_found", async () => {
    mockLookupTx.mockResolvedValueOnce({ status: "not_found" });

    await reconcileSubmission("sub-2", TX);

    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(mockSubUpdateMany).not.toHaveBeenCalled();
  });

  // "failed" (included and failed) hands the row back to the retry path; that
  // needs the attempts table and the retry cron, so it is tested against a real
  // database in payout-reconcile-db.test.ts.

  // #40 D4: Horizon's `successful` says the envelope applied, not what it paid.
  describe("when the envelope does not match the submission", () => {
    it("holds the payout for a human instead of confirming it", async () => {
      mockLookupTx.mockResolvedValueOnce(CONFIRMED);
      mockVerify.mockReturnValueOnce({ ok: false, mismatches: ["destination GX is not the bound wallet GY"] });

      await reconcileSubmission("sub-8", TX);

      expect(statusWrite("sub-8")).toEqual({
        payoutStatus: "needs_reconciliation",
        payoutError: expect.stringContaining("destination GX is not the bound wallet GY"),
      });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("sub-8"),
        expect.objectContaining({ level: "error" }),
      );
    });

    it("holds a payout whose submission has no bound wallet to check against", async () => {
      mockLookupTx.mockResolvedValueOnce(CONFIRMED);
      mockSubFindUnique.mockResolvedValueOnce({ walletAddress: null, payoutAmountUnits: 2_500_000n });

      await reconcileSubmission("sub-9", TX);

      expect(mockVerify).not.toHaveBeenCalled();
      expect(statusWrite("sub-9")).toMatchObject({
        payoutStatus: "needs_reconciliation",
        payoutError: expect.stringContaining("no bound wallet"),
      });
    });
  });

  it("confirms nothing while the payout account it would check against is unconfigured", async () => {
    delete process.env.STELLAR_PLATFORM_ACCOUNT;
    mockLookupTx.mockResolvedValueOnce(CONFIRMED);

    await reconcileSubmission("sub-10", TX);

    expect(mockSubUpdateMany).not.toHaveBeenCalled();
    expect(mockSubUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-10" },
        data: { payoutError: expect.stringContaining("cannot verify") },
      }),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("cannot verify"),
      expect.objectContaining({ level: "error" }),
    );
  });

  // #40 D2: a hash that was broadcast may have landed, so only Horizon's answer
  // may move the row. A read that throws is no answer at all.
  describe("on a Horizon read error", () => {
    it.each([
      ["a 5xx", Object.assign(new Error("Horizon 503"), { response: { status: 503 } })],
      ["a network error", new Error("fetch failed")],
      // Production row a5e7223b went `failed` this way: a non-hex hash draws a
      // 400, and three of them used to exhaust the retry budget.
      ["a 400 on a malformed hash", Object.assign(new Error("Bad Request"), { response: { status: 400 } })],
    ])("never spends a retry or marks failed, on %s", async (_label, err) => {
      mockLookupTx.mockRejectedValueOnce(err);

      await reconcileSubmission("sub-5", TX);

      expect(mockSubUpdateMany).not.toHaveBeenCalled();
      for (const [call] of mockSubUpdate.mock.calls) {
        expect(call.data).not.toHaveProperty("retryCount");
        expect(call.data).not.toHaveProperty("payoutStatus");
      }
    });

    it("does not mistake a database error after Horizon answered for a read error", async () => {
      mockLookupTx.mockResolvedValueOnce(CONFIRMED);
      mockSubUpdateMany.mockRejectedValueOnce(new Error("connection reset"));

      await expect(reconcileSubmission("sub-7", TX)).rejects.toThrow("connection reset");
      expect(mockSubUpdate).not.toHaveBeenCalled();
    });

    it("records the read error on the row", async () => {
      mockLookupTx.mockRejectedValueOnce(new Error("Horizon 503"));

      await reconcileSubmission("sub-6", TX);

      expect(mockSubUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-6" },
          data: { payoutError: expect.stringContaining("Horizon 503") },
        }),
      );
    });

    it("pages only once the payout has been unreadable past the threshold", async () => {
      mockLookupTx.mockRejectedValue(new Error("Horizon 503"));

      mockSubUpdate.mockResolvedValueOnce({ createdAt: new Date() });
      await reconcileSubmission("fresh", TX);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();

      mockSubUpdate.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 60 * 60_000) });
      await reconcileSubmission("stale", TX);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining("stale"),
        expect.objectContaining({ fingerprint: expect.arrayContaining(["stale"]) }),
      );
    });
  });
});
