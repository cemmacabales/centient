import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReprocess, mockFindUnique, mockUpdate, mockGetSession, mockRequireRole } =
  vi.hoisted(() => ({
    mockReprocess: vi.fn(),
    mockFindUnique: vi.fn(),
    mockUpdate: vi.fn(),
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
  mockUpdate.mockResolvedValue({});
  mockRequireRole.mockResolvedValue(null);
});

function makeReq(submissionId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/submissions/${submissionId}/retry`,
    { method: "POST" },
  );
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
      mockFindUnique.mockResolvedValueOnce(null);

      const res = await POST(makeReq("nonexistent"), {
        params: Promise.resolve({ id: "nonexistent" }),
      } as any);
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-retryable statuses", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "sub-1",
        payoutStatus: "pending",
        retryCount: 0,
      });

      const res = await POST(makeReq("sub-1"), {
        params: Promise.resolve({ id: "sub-1" }),
      } as any);
      expect(res.status).toBe(400);
    });

    it("retries a failed submission", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "sub-2",
        payoutStatus: "failed",
        retryCount: 3,
      });

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
      expect(mockReprocess).toHaveBeenCalledWith("sub-2");
    });

    it("retries an abandoned submission", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "sub-3",
        payoutStatus: "abandoned",
        retryCount: 5,
      });

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
      expect(mockReprocess).toHaveBeenCalledWith("sub-3");
    });

    it("resets retryCount to 0 on manual retry", async () => {
      mockFindUnique.mockResolvedValueOnce({
        id: "sub-4",
        payoutStatus: "failed",
        retryCount: 4,
      });

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
      mockFindUnique.mockResolvedValueOnce({
        id: "sub-5",
        payoutStatus: "failed",
        retryCount: 1,
      });
      mockReprocess.mockRejectedValueOnce(new Error("RPC timeout"));

      const res = await POST(makeReq("sub-5"), {
        params: Promise.resolve({ id: "sub-5" }),
      } as any);
      expect(res.status).toBe(500);
    });
  });
});
