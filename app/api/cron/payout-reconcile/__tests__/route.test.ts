import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockWaitForTx, mockFindMany, mockUpdate } = vi.hoisted(() => ({
  mockWaitForTx: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/payout", () => ({
  waitForTx: mockWaitForTx,
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    submission: {
      findMany: mockFindMany,
      update: mockUpdate,
    },
  },
}));

import { POST } from "../route";

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV_ORIGINAL };
  process.env.CRON_SECRET = "test-secret";
  mockFindMany.mockResolvedValue([]);
  mockUpdate.mockResolvedValue({});
});

afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
});

function cronReq(): NextRequest {
  return new NextRequest("http://localhost/api/cron/payout-reconcile", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret" },
  });
}

describe("/api/cron/payout-reconcile", () => {
  describe("authentication", () => {
    it("returns 401 when CRON_SECRET is not set", async () => {
      delete process.env.CRON_SECRET;
      const res = await POST(cronReq());
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const req = new NextRequest("http://localhost/api/cron/payout-reconcile", {
        method: "POST",
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("returns 401 when token does not match", async () => {
      const req = new NextRequest("http://localhost/api/cron/payout-reconcile", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });
  });

  describe("reconcile cycle", () => {
    it("returns success for empty queue", async () => {
      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(0);
      expect(body.failed).toBe(0);
    });

    it("marks submission confirmed when receipt status is success", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-1", payoutTxHash: "0xabc" },
      ]);
      mockWaitForTx.mockResolvedValueOnce({ status: "success" });

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(1);
      expect(body.failed).toBe(0);

      expect(mockWaitForTx).toHaveBeenCalledWith("0xabc");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-1" },
          data: { payoutStatus: "confirmed" },
        }),
      );
    });

    it("marks submission failed when receipt status is reverted", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-2", payoutTxHash: "0xdef" },
      ]);
      mockWaitForTx.mockResolvedValueOnce({ status: "reverted" });

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(0);
      expect(body.failed).toBe(1);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-2" },
          data: { payoutStatus: "failed", retryCount: { increment: 1 } },
        }),
      );
    });

    it("skips — leaves as sent — when waitForTx times out", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-3", payoutTxHash: "0xghi" },
      ]);
      const timeoutErr = new Error("timed out");
      timeoutErr.name = "WaitForTransactionReceiptTimeoutError";
      mockWaitForTx.mockRejectedValueOnce(timeoutErr);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(0);
      expect(body.failed).toBe(0);
      expect(body.skipped).toBe(0);

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("skips when error message contains 'timed out'", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-3b", payoutTxHash: "0xghi" },
      ]);
      const timeoutErr = new Error("Transaction timed out after 30s");
      mockWaitForTx.mockRejectedValueOnce(timeoutErr);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("skips generic non-timeout receipt errors so next cycle can retry", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-4", payoutTxHash: "0xjkl" },
      ]);
      mockWaitForTx.mockRejectedValueOnce(new Error("RPC connection error"));

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.failed).toBe(0);

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("skips submissions with null payoutTxHash", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-5", payoutTxHash: null },
      ]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.skipped).toBe(1);
      expect(mockWaitForTx).not.toHaveBeenCalled();
    });

    it("processes multiple submissions in a batch", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-6", payoutTxHash: "0xone" },
        { id: "sub-7", payoutTxHash: "0xtwo" },
        { id: "sub-8", payoutTxHash: "0xthree" },
      ]);
      mockWaitForTx
        .mockResolvedValueOnce({ status: "success" })
        .mockResolvedValueOnce({ status: "reverted" })
        .mockRejectedValueOnce(new Error("Connection refused"));

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.confirmed).toBe(1);
      expect(body.failed).toBe(1);
      expect(mockWaitForTx).toHaveBeenCalledTimes(3);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-7" },
          data: { payoutStatus: "failed", retryCount: { increment: 1 } },
        }),
      );
    });

    it("handles global error gracefully", async () => {
      mockFindMany.mockRejectedValueOnce(new Error("DB down"));

      const res = await POST(cronReq());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Reconcile cycle crashed");
    });
  });
});
