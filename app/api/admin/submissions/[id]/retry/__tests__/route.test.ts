import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReprocessTx, mockQueryRaw, mockUpdate, mockGetSession, mockRequireRole } =
  vi.hoisted(() => ({
    mockReprocessTx: vi.fn(),
    mockQueryRaw: vi.fn(),
    mockUpdate: vi.fn(),
    mockGetSession: vi.fn(),
    mockRequireRole: vi.fn(),
  }));

vi.mock("@/lib/payout-service", () => ({
  reprocessPayoutWithNonceSafetyTx: mockReprocessTx,
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: vi.fn(async (fn: any) => {
      const tx = {
        $queryRaw: mockQueryRaw,
        submission: {
          update: mockUpdate,
        },
      };
      return fn(tx);
    }),
  },
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminSession: mockGetSession,
  requireRoleForRoute: mockRequireRole,
}));

import { POST } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  mockReprocessTx.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue({});
  mockRequireRole.mockResolvedValue(null);
});

function makeReq(submissionId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/submissions/${submissionId}/retry`,
    { method: "POST" },
  );
}

function makeRow(opts: {
  id: string;
  payout_status: string;
  retry_count: number;
  last_retried_at?: Date | null;
  wallet_address?: string;
  payout_amount_wei?: string;
}) {
  return {
    id: opts.id,
    payout_status: opts.payout_status,
    retry_count: opts.retry_count,
    last_retried_at: opts.last_retried_at ?? null,
    wallet_address: opts.wallet_address ?? "0xabc",
    payout_amount_wei: opts.payout_amount_wei ?? "100",
  };
}

describe("/api/admin/submissions/[id]/retry", () => {
  describe("authentication", () => {
    it("returns 401 when no admin session", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const res = await POST(makeReq("sub-1"), {
        params: Promise.resolve({ id: "sub-1" }),
      } as any);
      expect(res.status).toBe(401);
    });

    it("returns 403 when role check fails", async () => {
      mockGetSession.mockResolvedValueOnce({ email: "user@test.com", sub: "admin-1" });
      mockRequireRole.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      );

      const res = await POST(makeReq("sub-1"), {
        params: Promise.resolve({ id: "sub-1" }),
      } as any);
      expect(res.status).toBe(403);
    });
  });

  describe("retry logic", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue({ email: "admin@test.com", sub: "admin-1" });
    });

    it("returns 404 for unknown submission", async () => {
      mockQueryRaw.mockResolvedValueOnce([]);

      const res = await POST(makeReq("nonexistent"), {
        params: Promise.resolve({ id: "nonexistent" }),
      } as any);
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-retryable statuses", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-1", payout_status: "pending", retry_count: 0 }),
      ]);

      const res = await POST(makeReq("sub-1"), {
        params: Promise.resolve({ id: "sub-1" }),
      } as any);
      expect(res.status).toBe(400);
    });

    it("retries a failed submission", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-2", payout_status: "failed", retry_count: 3 }),
      ]);

      const res = await POST(makeReq("sub-2"), {
        params: Promise.resolve({ id: "sub-2" }),
      } as any);
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-2" },
          data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
        }),
      );
      expect(mockReprocessTx).toHaveBeenCalledWith(
        expect.anything(),
        "sub-2",
        "0xabc",
        100n,
      );
    });

    it("retries an abandoned submission", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-3", payout_status: "abandoned", retry_count: 5 }),
      ]);

      const res = await POST(makeReq("sub-3"), {
        params: Promise.resolve({ id: "sub-3" }),
      } as any);
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-3" },
          data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
        }),
      );
    });

    it("resets retryCount to 0 on manual retry", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-4", payout_status: "failed", retry_count: 4 }),
      ]);

      const res = await POST(makeReq("sub-4"), {
        params: Promise.resolve({ id: "sub-4" }),
      } as any);
      expect(res.status).toBe(200);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-4" },
          data: expect.objectContaining({ retryCount: 0 }),
        }),
      );
    });

    it("returns 500 when reprocess fails", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-5", payout_status: "failed", retry_count: 1 }),
      ]);
      mockReprocessTx.mockRejectedValueOnce(new Error("RPC timeout"));

      const res = await POST(makeReq("sub-5"), {
        params: Promise.resolve({ id: "sub-5" }),
      } as any);
      expect(res.status).toBe(500);
    });

    it("restores lastRetriedAt in rollback", async () => {
      const originalLast = new Date("2024-06-01");
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({
          id: "sub-6",
          payout_status: "failed",
          retry_count: 2,
          last_retried_at: originalLast,
        }),
      ]);
      mockReprocessTx.mockRejectedValueOnce(new Error("RPC timeout"));

      const res = await POST(makeReq("sub-6"), {
        params: Promise.resolve({ id: "sub-6" }),
      } as any);
      expect(res.status).toBe(500);
      expect(mockUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { id: "sub-6" },
          data: expect.objectContaining({
            retryCount: 2,
            lastRetriedAt: originalLast,
            payoutStatus: "failed",
          }),
        }),
      );
    });
  });
});
