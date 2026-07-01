import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetSession, mockRequireRole, mockAuditLog } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRequireRole: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return { ...actual, getAdminSession: mockGetSession, requireRoleForRoute: mockRequireRole };
});
vi.mock("@/lib/audit", () => ({ auditLog: mockAuditLog }));

import { PATCH } from "../route";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

const ADMIN = { sub: "admin-1", role: "SUPER_ADMIN" as const };

// A valid, case-sensitive Stellar `G…` StrKey. ST-4d stores WALLET bans verbatim
// (no `.toLowerCase()`) and rejects malformed addresses, so banning a wallet
// requires a real StrKey rather than the factory's legacy `0x…`.
const G_WALLET = "GDJ3LPVCSFVJHBTX47I7OBG2ZK2ZH3KQAHAHMNTJW3JLSLZUWC4OQQ7P";

function makeReq(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/admin/flagged-withdrawals/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(id: string, body: Record<string, unknown>) {
  return PATCH(makeReq(id, body), { params: Promise.resolve({ id }) });
}

async function createFlag(
  userId: string,
  overrides: Partial<{ reason: "BANNED_IDENTITY" | "SHARED_WALLET" | "INELIGIBLE"; walletAddress: string }> = {},
) {
  return prisma.flaggedWithdrawal.create({
    data: {
      userId,
      walletAddress: overrides.walletAddress ?? null,
      reason: overrides.reason ?? "SHARED_WALLET",
      balanceUnits: 50000000n, // 5 XLM
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(ADMIN);
  mockRequireRole.mockResolvedValue(null);
});

describe("PATCH /api/admin/flagged-withdrawals/[id]", () => {
  it("returns 401 with no admin session", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await call("00000000-0000-0000-0000-000000000000", { action: "approve" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the admin lacks the role", async () => {
    mockRequireRole.mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    const res = await call("00000000-0000-0000-0000-000000000000", { action: "approve" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid action", async () => {
    const user = await createUser();
    const flag = await createFlag(user.id);
    const res = await call(flag.id, { action: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_action" });
  });

  it("returns 404 for an unknown flag", async () => {
    const res = await call("00000000-0000-0000-0000-000000000000", { action: "approve" });
    expect(res.status).toBe(404);
  });

  it("approves a flag and writes an audit log", async () => {
    const user = await createUser();
    const flag = await createFlag(user.id);

    const res = await call(flag.id, { action: "approve" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("APPROVED");

    const after = await prisma.flaggedWithdrawal.findUnique({ where: { id: flag.id } });
    expect(after?.status).toBe("APPROVED");
    expect(after?.resolvedByAdminId).toBe(ADMIN.sub);
    expect(after?.resolvedAt).not.toBeNull();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "flagged_withdrawal.approve", targetId: flag.id }),
    );
  });

  it("rejects a flag without banning", async () => {
    const user = await createUser();
    const flag = await createFlag(user.id);

    const res = await call(flag.id, { action: "reject", note: "looks fine" });
    expect(res.status).toBe(200);

    const after = await prisma.flaggedWithdrawal.findUnique({ where: { id: flag.id } });
    expect(after?.status).toBe("REJECTED");
    expect(after?.resolutionNote).toBe("looks fine");
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u?.isBanned).toBe(false);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "flagged_withdrawal.reject" }),
    );
  });

  it("requires confirmation before a ban", async () => {
    const user = await createUser({ email: "x@example.com" });
    const flag = await createFlag(user.id, { walletAddress: user.walletAddress });

    const res = await call(flag.id, { action: "ban" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "confirmation_required" });

    const after = await prisma.flaggedWithdrawal.findUnique({ where: { id: flag.id } });
    expect(after?.status).toBe("PENDING");
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u?.isBanned).toBe(false);
  });

  it("bans the account and binds the ban to email, wallet and userId", async () => {
    const user = await createUser({ email: "fraud@example.com", walletAddress: G_WALLET });
    const flag = await createFlag(user.id, {
      reason: "BANNED_IDENTITY",
      walletAddress: user.walletAddress,
    });

    const res = await call(flag.id, { action: "ban", confirm: true });
    expect(res.status).toBe(200);

    const after = await prisma.flaggedWithdrawal.findUnique({ where: { id: flag.id } });
    expect(after?.status).toBe("REJECTED");

    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u?.isBanned).toBe(true);

    const banned = await prisma.bannedIdentity.findMany();
    const types = banned.map((b) => b.identifierType).sort();
    expect(types).toEqual(["EMAIL", "USER_ID", "WALLET"]);
    expect(
      banned.find((b) => b.identifierType === "WALLET")?.identifierValue,
    ).toBe(user.walletAddress); // case-preserved StrKey, never lowercased

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.ban", targetId: user.id }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "flagged_withdrawal.ban" }),
    );
  });

  it("increments banCount instead of overwriting it", async () => {
    const user = await createUser({ email: "repeat@example.com", walletAddress: G_WALLET });
    await prisma.user.update({ where: { id: user.id }, data: { banCount: 2 } });
    const flag = await createFlag(user.id, {
      reason: "BANNED_IDENTITY",
      walletAddress: user.walletAddress,
    });

    const res = await call(flag.id, { action: "ban", confirm: true });
    expect(res.status).toBe(200);

    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u?.isBanned).toBe(true);
    expect(u?.banCount).toBe(3);
  });

  it("returns 409 when the flag is already resolved", async () => {
    const user = await createUser();
    const flag = await createFlag(user.id);
    await prisma.flaggedWithdrawal.update({ where: { id: flag.id }, data: { status: "APPROVED" } });

    const res = await call(flag.id, { action: "reject" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_resolved" });
  });
});
