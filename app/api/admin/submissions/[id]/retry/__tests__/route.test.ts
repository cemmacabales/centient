import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReprocess, mockQueryRaw, mockTxUpdate, mockUpdate, mockFindUnique, mockGetSession, mockRequireRole } =
  vi.hoisted(() => ({
    mockReprocess: vi.fn(),
    mockQueryRaw: vi.fn(),
    mockTxUpdate: vi.fn(),
    mockUpdate: vi.fn(),
    mockFindUnique: vi.fn(),
    mockGetSession: vi.fn(),
    mockRequireRole: vi.fn(),
  }));

vi.mock("@/lib/payout-service", () => ({
  reprocessPayoutWithNonceSafety: mockReprocess,
}));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    submission: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
    $transaction: vi.fn(async (fn: any) => {
      const tx = {
        $queryRaw: mockQueryRaw,
        submission: {
          update: mockTxUpdate,
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
  mockReprocess.mockResolvedValue(undefined);
  mockTxUpdate.mockResolvedValue({});
  mockUpdate.mockResolvedValue({});
  mockFindUnique.mockResolvedValue({ payoutTxHash: null });
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
  payoutStatus: string;
  retryCount: number;
  lastRetriedAt?: Date | null;
  walletAddress?: string;
  payoutAmountStroops?: string;
}) {
  return {
    id: opts.id,
    payoutStatus: opts.payoutStatus,
    retryCount: opts.retryCount,
    lastRetriedAt: opts.lastRetriedAt ?? null,
    walletAddress: opts.walletAddress ?? "0xabc",
    payoutAmountStroops: opts.payoutAmountStroops ?? "100",
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
        makeRow({ id: "sub-1", payoutStatus: "pending", retryCount: 0 }),
      ]);

      const res = await POST(makeReq("sub-1"), {
        params: Promise.resolve({ id: "sub-1" }),
      } as any);
      expect(res.status).toBe(400);
    });

    it("retries a failed submission", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-2", payoutStatus: "failed", retryCount: 3 }),
      ]);

      const res = await POST(makeReq("sub-2"), {
        params: Promise.resolve({ id: "sub-2" }),
      } as any);
      expect(res.status).toBe(200);
      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-2" },
          data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
        }),
      );
      expect(mockReprocess).toHaveBeenCalledWith("sub-2");
    });

    it("retries an abandoned submission", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-3", payoutStatus: "abandoned", retryCount: 5 }),
      ]);

      const res = await POST(makeReq("sub-3"), {
        params: Promise.resolve({ id: "sub-3" }),
      } as any);
      expect(res.status).toBe(200);
      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-3" },
          data: { retryCount: 0, lastRetriedAt: null, payoutStatus: "pending" },
        }),
      );
    });

    it("resets retryCount to 0 on manual retry", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-4", payoutStatus: "failed", retryCount: 4 }),
      ]);

      const res = await POST(makeReq("sub-4"), {
        params: Promise.resolve({ id: "sub-4" }),
      } as any);
      expect(res.status).toBe(200);

      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-4" },
          data: expect.objectContaining({ retryCount: 0 }),
        }),
      );
    });

    it("returns 500 when reprocess fails", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-5", payoutStatus: "failed", retryCount: 1 }),
      ]);
      mockReprocess.mockRejectedValueOnce(new Error("RPC timeout"));

      const res = await POST(makeReq("sub-5"), {
        params: Promise.resolve({ id: "sub-5" }),
      } as any);
      expect(res.status).toBe(500);
    });

    it("restores original state in rollback when reprocess fails and no txHash saved", async () => {
      const originalLast = new Date("2024-06-01");
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({
          id: "sub-6",
          payoutStatus: "failed",
          retryCount: 2,
          lastRetriedAt: originalLast,
        }),
      ]);
      mockReprocess.mockRejectedValueOnce(new Error("RPC timeout"));
      // payoutTxHash is null — safe to restore original status
      mockFindUnique.mockResolvedValueOnce({ payoutTxHash: null });

      const res = await POST(makeReq("sub-6"), {
        params: Promise.resolve({ id: "sub-6" }),
      } as any);
      expect(res.status).toBe(500);
      // Rollback runs on the top-level client, outside the claim transaction.
      expect(mockUpdate).toHaveBeenCalledWith(
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

    it("does not overwrite sent status when txHash is already saved on failure", async () => {
      mockQueryRaw.mockResolvedValueOnce([
        makeRow({ id: "sub-7", payoutStatus: "failed", retryCount: 1 }),
      ]);
      mockReprocess.mockRejectedValueOnce(new Error("creditUserTotals DB error"));
      // txHash was persisted before the error — submission is already "sent"
      mockFindUnique.mockResolvedValueOnce({ payoutTxHash: "0xalreadysaved" });

      const res = await POST(makeReq("sub-7"), {
        params: Promise.resolve({ id: "sub-7" }),
      } as any);
      expect(res.status).toBe(500);
      // Must NOT call update — reconciler handles the on-chain verification
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
