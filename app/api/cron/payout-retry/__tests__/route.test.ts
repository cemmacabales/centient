import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReprocess, mockFindMany, mockUpdate } = vi.hoisted(() => ({
  mockReprocess: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/payout-service", () => ({
  reprocessPayoutWithNonceSafety: mockReprocess,
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

vi.mock("@/lib/admin-data", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-data")>();
  return { ...actual };
});

import { POST } from "../route";

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV_ORIGINAL };
  process.env.CRON_SECRET = "test-secret";
  mockReprocess.mockResolvedValue(undefined);
  mockFindMany.mockResolvedValue([]);
  mockUpdate.mockResolvedValue({});
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
      const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-1",
            payoutStatus: "failed",
            retryCount: 1,
            lastRetriedAt: fourMinutesAgo,
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(1);
      expect(mockReprocess).toHaveBeenCalledWith("sub-1");
    });

    it("skips failed submissions still in backoff", async () => {
      const justNow = new Date();
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-2",
            payoutStatus: "failed",
            retryCount: 1,
            lastRetriedAt: justNow,
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(0);
      expect(mockReprocess).not.toHaveBeenCalled();
    });

    it("reprocesses stuck pending submissions", async () => {
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-3",
            payoutStatus: "pending",
            retryCount: 0,
            lastRetriedAt: null,
            createdAt: sixMinutesAgo,
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.retried).toBe(1);
      expect(mockReprocess).toHaveBeenCalledWith("sub-3");
    });

    it("respects backoff for retryCount=0 (60s via createdAt)", async () => {
      const thirtySecondsAgo = new Date(Date.now() - 30_000);
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-4",
            payoutStatus: "failed",
            retryCount: 0,
            lastRetriedAt: null,
            createdAt: thirtySecondsAgo,
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(0);
    });

    it("respects backoff for retryCount=2 (4min)", async () => {
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-5",
            payoutStatus: "failed",
            retryCount: 2,
            lastRetriedAt: threeMinutesAgo,
            createdAt: new Date(Date.now() - 30 * 60 * 1000),
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(0);
    });

    it("caps backoff at 8 minutes", async () => {
      const sevenMinutesAgo = new Date(Date.now() - 7 * 60 * 1000);
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-6",
            payoutStatus: "failed",
            retryCount: 4,
            lastRetriedAt: sevenMinutesAgo,
            createdAt: new Date(Date.now() - 60 * 60 * 1000),
          },
        ])
        .mockResolvedValueOnce([]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(0);
    });

    it("abandons submissions with retryCount >= 5", async () => {
      mockFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "sub-7" }, { id: "sub-8" }]);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.abandoned).toBe(2);
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-7" },
          data: { payoutStatus: "abandoned" },
        }),
      );
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-8" },
          data: { payoutStatus: "abandoned" },
        }),
      );
    });

    it("continues processing remaining jobs when one fails", async () => {
      const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);
      mockFindMany
        .mockResolvedValueOnce([
          {
            id: "sub-a",
            payoutStatus: "failed",
            retryCount: 1,
            lastRetriedAt: fourMinutesAgo,
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
          },
          {
            id: "sub-b",
            payoutStatus: "failed",
            retryCount: 1,
            lastRetriedAt: fourMinutesAgo,
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
          },
        ])
        .mockResolvedValueOnce([]);

      mockReprocess.mockRejectedValueOnce(new Error("RPC down"));
      mockReprocess.mockResolvedValueOnce(undefined);

      const res = await POST(cronReq());
      const body = await res.json();
      expect(body.retried).toBe(1);
      expect(body.errored).toBe(1);
      expect(mockReprocess).toHaveBeenCalledTimes(2);
    });

    it("handles global error gracefully", async () => {
      mockFindMany.mockRejectedValueOnce(new Error("DB down"));

      const res = await POST(cronReq());
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Cron cycle crashed");
    });
  });
});
