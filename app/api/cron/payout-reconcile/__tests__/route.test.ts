import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// The reconcile cron now resolves finality via Horizon `getTxStatus` (ST-3b),
// which returns "confirmed" | "failed" | "not_found" — replacing the EVM
// `waitForTx` receipt poll.
const { mockGetTxStatus, mockFindMany, mockUpdate } = vi.hoisted(() => ({
  mockGetTxStatus: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/stellar/client", () => ({
  getTxStatus: mockGetTxStatus,
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

// Bare-hex Stellar tx hashes (no EVM `0x` prefix).
const TX_A = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const TX_B = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const TX_C = "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333";

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

    it("marks submission confirmed when Horizon reports confirmed", async () => {
      mockFindMany.mockResolvedValueOnce([{ id: "sub-1", payoutTxHash: TX_A }]);
      mockGetTxStatus.mockResolvedValueOnce("confirmed");

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(1);
      expect(body.failed).toBe(0);

      expect(mockGetTxStatus).toHaveBeenCalledWith(TX_A);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-1" },
          data: { payoutStatus: "confirmed" },
        }),
      );
    });

    it("marks submission failed when Horizon reports failed", async () => {
      mockFindMany.mockResolvedValueOnce([{ id: "sub-2", payoutTxHash: TX_B }]);
      mockGetTxStatus.mockResolvedValueOnce("failed");

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

    it("leaves submission sent when Horizon reports not_found (still pending)", async () => {
      mockFindMany.mockResolvedValueOnce([{ id: "sub-3", payoutTxHash: TX_C }]);
      mockGetTxStatus.mockResolvedValueOnce("not_found");

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(0);
      expect(body.failed).toBe(0);

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("skips (leaves sent) on a transient Horizon read error", async () => {
      mockFindMany.mockResolvedValueOnce([{ id: "sub-4", payoutTxHash: TX_A }]);
      mockGetTxStatus.mockRejectedValueOnce(new Error("Horizon 503"));

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.confirmed).toBe(0);
      expect(body.failed).toBe(0);

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("processes multiple submissions in a batch", async () => {
      mockFindMany.mockResolvedValueOnce([
        { id: "sub-6", payoutTxHash: TX_A },
        { id: "sub-7", payoutTxHash: TX_B },
        { id: "sub-8", payoutTxHash: TX_C },
      ]);
      mockGetTxStatus
        .mockResolvedValueOnce("confirmed")
        .mockResolvedValueOnce("failed")
        .mockRejectedValueOnce(new Error("Connection refused"));

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.confirmed).toBe(1);
      expect(body.failed).toBe(1);
      expect(mockGetTxStatus).toHaveBeenCalledTimes(3);

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
