import { vi, describe, it, expect, beforeEach } from "vitest";

// ST-3b: the reconciler resolves finality via Horizon `getTxStatus`
// ("confirmed" | "failed" | "not_found"). These tests mock Horizon and assert
// the sent→confirmed / failed→retry / not_found→stay-pending mapping.
const {
  mockGetTxStatus,
  mockSubFindUnique,
  mockSubUpdate,
  mockJobFindUnique,
  mockJobUpdate,
} = vi.hoisted(() => ({
  mockGetTxStatus: vi.fn(),
  mockSubFindUnique: vi.fn(),
  mockSubUpdate: vi.fn(),
  mockJobFindUnique: vi.fn(),
  mockJobUpdate: vi.fn(),
}));

vi.mock("@/lib/stellar/client", () => ({
  getTxStatus: mockGetTxStatus,
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
    submission: { findUnique: mockSubFindUnique, update: mockSubUpdate },
    payoutJob: { findUnique: mockJobFindUnique, update: mockJobUpdate },
    $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
  },
}));

import { processSubmission, processWithdrawal } from "../reconciler";
import { refundReversal } from "@/lib/user-balance";

const TX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

beforeEach(() => {
  vi.clearAllMocks();
  mockSubUpdate.mockResolvedValue({});
  mockJobUpdate.mockResolvedValue({});
  mockSubFindUnique.mockResolvedValue({ id: "sub", retryCount: 0 });
  mockJobFindUnique.mockResolvedValue({ id: "job", retryCount: 0 });
});

describe("processSubmission", () => {
  it("marks the submission confirmed when Horizon reports confirmed", async () => {
    mockGetTxStatus.mockResolvedValueOnce("confirmed");

    await processSubmission("sub-1", TX);

    expect(mockGetTxStatus).toHaveBeenCalledWith(TX);
    expect(mockSubUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-1" },
        data: expect.objectContaining({ payoutStatus: "confirmed" }),
      }),
    );
  });

  it("leaves the submission untouched (still pending) on not_found", async () => {
    mockGetTxStatus.mockResolvedValueOnce("not_found");

    await processSubmission("sub-2", TX);

    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it("routes to a bounded retry (increment) when Horizon reports failed", async () => {
    mockGetTxStatus.mockResolvedValueOnce("failed");
    mockSubFindUnique.mockResolvedValueOnce({ id: "sub-3", retryCount: 0 });

    await processSubmission("sub-3", TX);

    expect(mockSubUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-3" },
        data: expect.objectContaining({ retryCount: 1 }),
      }),
    );
  });

  it("marks failed after exhausting the retry budget", async () => {
    mockGetTxStatus.mockResolvedValueOnce("failed");
    mockSubFindUnique.mockResolvedValueOnce({ id: "sub-4", retryCount: 2 });

    await processSubmission("sub-4", TX);

    expect(mockSubUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-4" },
        data: expect.objectContaining({ payoutStatus: "failed", retryCount: 3 }),
      }),
    );
  });

  it("soft-retries (does not mark failed) on a transient Horizon read error", async () => {
    mockGetTxStatus.mockRejectedValueOnce(new Error("Horizon 503"));
    mockSubFindUnique.mockResolvedValueOnce({ id: "sub-5", retryCount: 0 });

    await processSubmission("sub-5", TX);

    expect(mockSubUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sub-5" },
        data: expect.objectContaining({ retryCount: 1 }),
      }),
    );
  });
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

  it("refunds and fails the job once the retry budget is exhausted on failed", async () => {
    mockGetTxStatus.mockResolvedValueOnce("failed");
    mockJobFindUnique.mockResolvedValueOnce({ id: "job-3", retryCount: 2 });

    await processWithdrawal("job-3", TX, "user-3", 250n);

    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-3" },
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
});
