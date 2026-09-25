import { vi, describe, it, expect, beforeEach } from "vitest";

// ST-3b: the loop's legacy withdrawal leg resolves finality via Horizon
// `getTxStatus`. Submissions are settled by `reconcileSubmission`, tested in
// payout-reconcile.test.ts.
const {
  mockGetTxStatus,
  mockJobFindUnique,
  mockJobUpdate,
  mockJobUpdateMany,
} = vi.hoisted(() => ({
  mockGetTxStatus: vi.fn(),
  mockJobFindUnique: vi.fn(),
  mockJobUpdate: vi.fn(),
  mockJobUpdateMany: vi.fn(),
}));

vi.mock("@/lib/stellar/client", () => ({
  getTxStatus: mockGetTxStatus,
  // #38's stranded-attempt revival reads it; covered in payout-attempt-revival-db.
  latestLedgerCloseMs: vi.fn(async () => null),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/user-balance", () => ({ refundReversal: vi.fn(async () => 0n) }));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    payoutJob: {
      findUnique: mockJobFindUnique,
      update: mockJobUpdate,
      updateMany: mockJobUpdateMany,
    },
    $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
  },
}));

import { processWithdrawal } from "../reconciler";
import { refundReversal } from "@/lib/user-balance";

const TX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

beforeEach(() => {
  vi.clearAllMocks();
  mockJobUpdate.mockResolvedValue({});
  // F1: the terminal failure is claimed with a conditional update — one row
  // matched means this pass is the one that finalizes the job and refunds it.
  mockJobUpdateMany.mockResolvedValue({ count: 1 });
  mockJobFindUnique.mockResolvedValue({ id: "job", retryCount: 0 });
});

describe("processWithdrawal", () => {
  it("marks the job done when Horizon reports confirmed", async () => {
    mockGetTxStatus.mockResolvedValueOnce("confirmed");

    await processWithdrawal("job-1", TX, "user-1", 100n);

    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1" },
        data: expect.objectContaining({ status: "done" }),
      }),
    );
  });

  it("leaves the job processing (no refund) on not_found", async () => {
    mockGetTxStatus.mockResolvedValueOnce("not_found");

    await processWithdrawal("job-2", TX, "user-2", 100n);

    expect(mockJobUpdate).not.toHaveBeenCalled();
    expect(refundReversal).not.toHaveBeenCalled();
  });

  // #40 D2/D7: refunding a withdrawal that actually paid is a double pay.
  it("never refunds, fails or spends a retry on a Horizon read error", async () => {
    mockGetTxStatus.mockRejectedValueOnce(new Error("Horizon 503"));
    mockJobFindUnique.mockResolvedValue({ id: "job-4", retryCount: 2 });

    await processWithdrawal("job-4", TX, "user-4", 250n);

    expect(refundReversal).not.toHaveBeenCalled();
    for (const [call] of mockJobUpdate.mock.calls) {
      expect(call.data).not.toHaveProperty("retryCount");
      expect(call.data).not.toHaveProperty("status");
    }
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-4" },
        data: { lastError: expect.stringContaining("Horizon 503") },
      }),
    );
  });

  it("refunds and fails the job once the retry budget is exhausted on failed", async () => {
    mockGetTxStatus.mockResolvedValueOnce("failed");
    mockJobFindUnique.mockResolvedValueOnce({ id: "job-3", retryCount: 2 });

    await processWithdrawal("job-3", TX, "user-3", 250n);

    expect(mockJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-3", status: "processing" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(refundReversal).toHaveBeenCalledWith(
      "user-3",
      250n,
      "job-3",
      expect.any(String),
    );
  });

  // F1: two reconcilers can both reach a withdrawal's terminal path. The move
  // out of `processing` is what decides which one owns it, and the loser must
  // not reverse the debit — a second reversal is withdrawable balance the
  // platform never took.
  it("does not refund when another pass already finalized the job", async () => {
    mockGetTxStatus.mockResolvedValueOnce("failed");
    mockJobFindUnique.mockResolvedValueOnce({ id: "job-5", retryCount: 2 });
    mockJobUpdateMany.mockResolvedValueOnce({ count: 0 });

    await processWithdrawal("job-5", TX, "user-5", 250n);

    expect(refundReversal).not.toHaveBeenCalled();
  });
});
