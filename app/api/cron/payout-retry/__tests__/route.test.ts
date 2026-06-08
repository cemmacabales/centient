import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReprocess, mockQueryRaw, mockUpdateMany } = vi.hoisted(() => ({
  mockReprocess: vi.fn(),
  mockQueryRaw: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/payout-service", () => ({
  reprocessPayoutWithNonceSafety: mockReprocess,
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: mockQueryRaw,
    submission: {
      updateMany: mockUpdateMany,
    },
  },
}));

import { POST } from "../route";

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV_ORIGINAL };
  process.env.CRON_SECRET = "test-secret";
  mockReprocess.mockResolvedValue(undefined);
  mockQueryRaw.mockResolvedValue([]);
  mockUpdateMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
});

function cronReq(): NextRequest {
  return new NextRequest("http://localhost/api/cron/payout-retry", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret" },
  });
}

describe("/api/cron/payout-retry", () => {
  describe("authentication", () => {
    it("returns 401 when CRON_SECRET is not set", async () => {
      delete process.env.CRON_SECRET;
      const res = await POST(cronReq());
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const req = new NextRequest("http://localhost/api/cron/payout-retry", {
        method: "POST",
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("returns 401 when token does not match", async () => {
      const req = new NextRequest("http://localhost/api/cron/payout-retry", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });
  });

  describe("cron cycle", () => {
    it("returns success for empty queue", async () => {
      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(0);
      expect(body.abandoned).toBe(0);
    });

    it("reprocesses failed submissions past their backoff window", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        { id: "sub-1", wallet_address: "0xaaa", retry_count: 1 },
      ]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(1);
      expect(mockReprocess).toHaveBeenCalledWith("sub-1");
    });

    it("skips failed submissions still in backoff", async () => {
      // DB query already filters them out; both queries return empty
      mockQueryRaw.mockResolvedValueOnce([]);
      mockQueryRaw.mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(0);
      expect(mockReprocess).not.toHaveBeenCalled();
    });

    it("reprocesses stuck pending submissions", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        { id: "sub-3", wallet_address: "0xbbb", retry_count: 0 },
      ]);
      mockQueryRaw.mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(1);
      expect(mockReprocess).toHaveBeenCalledWith("sub-3");
    });

    it("respects backoff for retryCount=0 (60s via createdAt)", async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      mockQueryRaw.mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(0);
    });

    it("respects backoff for retryCount=2 (4min)", async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      mockQueryRaw.mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(0);
    });

    it("caps backoff at 8 minutes", async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      mockQueryRaw.mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(0);
    });

    it("abandons submissions with retryCount >= 5 via updateMany", async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      mockQueryRaw.mockResolvedValueOnce([]);
      mockUpdateMany.mockResolvedValueOnce({ count: 2 });

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.abandoned).toBe(2);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            payoutStatus: { in: ["failed", "pending"] },
            retryCount: { gte: 5 },
          },
          data: { payoutStatus: "abandoned" },
        }),
      );
    });

    it("continues processing remaining jobs when one fails", async () => {
      mockQueryRaw.mockResolvedValueOnce([]);
      mockQueryRaw.mockResolvedValueOnce([
        { id: "sub-a", wallet_address: "0xaaa", retry_count: 1 },
        { id: "sub-b", wallet_address: "0xbbb", retry_count: 1 },
      ]);

      mockReprocess.mockRejectedValueOnce(new Error("RPC down"));
      mockReprocess.mockResolvedValueOnce(undefined);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(1);
      expect(body.errored).toBe(1);
      expect(mockReprocess).toHaveBeenCalledTimes(2);
    });

    it("handles global error gracefully", async () => {
      mockQueryRaw.mockRejectedValueOnce(new Error("DB down"));

      const res = await POST(cronReq());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Cron cycle crashed");
    });
  });
});
