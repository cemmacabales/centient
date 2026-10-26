// #203 — the admin's weekly board and the name hide (board 10).
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/gamification/server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));
vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return { ...actual, getAdminSession: vi.fn() };
});

import { GET } from "@/app/api/admin/board/route";
import { POST as HIDE } from "@/app/api/admin/board/hide/route";
import { auditLog } from "@/lib/audit";
import { getAdminSession, type AdminJWTPayload } from "@/lib/admin-auth";
import { manilaDayKey, manilaWeekKey } from "@/lib/gamification/time";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createAdminUser, createUser } from "@/tests/helpers/factories";

let adminId: string;
let seq = 0;

const as = (role: "SUPER_ADMIN" | "CUSTOMER") =>
  vi.mocked(getAdminSession).mockResolvedValue({ sub: adminId, email: "a@b.co", role, companyName: null } as AdminJWTPayload);

beforeEach(async () => {
  await truncateAll();
  vi.mocked(auditLog).mockReset();
  adminId = (await createAdminUser({ role: "SUPER_ADMIN" })).id;
  as("SUPER_ADMIN");
});

async function labeler(displayName: string | null, showOnBoard: boolean, amount: number) {
  const u = await createUser();
  await prisma.user.update({ where: { id: u.id }, data: { displayName, showOnBoard, tier: 1 } });
  await prisma.xpEvent.create({
    data: { userId: u.id, kind: "ANSWER", amount, dedupeKey: `t:${++seq}`, dayKey: manilaDayKey(), weekKey: manilaWeekKey() },
  });
  return u.id;
}

async function hide(body: unknown) {
  const res = await HIDE(new NextRequest("http://localhost/api/admin/board/hide", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

describe("GET /api/admin/board", () => {
  it("lists this week's places with shown names, and opted-out rows as such", async () => {
    const a = await labeler("migs.dela", true, 300);
    await labeler("quiet.one", false, 200);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([
      { rank: 1, userId: a, name: "migs.dela", optedOut: false, tier: 1, xp: 300 },
      { rank: 2, userId: expect.any(String), name: null, optedOut: true, tier: 1, xp: 200 },
    ]);
    expect(JSON.stringify(body)).not.toContain("quiet.one");
  });

  it("is for super admins only", async () => {
    as("CUSTOMER");
    expect((await GET()).status).toBe(403);
  });
});

describe("POST /api/admin/board/hide", () => {
  it("hides a name, retires it and audit-logs the hide", async () => {
    const a = await labeler("rude.name", true, 300);
    expect(await hide({ userId: a })).toEqual({ status: 200, body: { hidden: true } });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ displayName: null, showOnBoard: false });
    expect(await prisma.retiredDisplayName.findUnique({ where: { name: "rude.name" } })).not.toBeNull();
    expect(vi.mocked(auditLog).mock.calls[0][0]).toMatchObject({
      adminUserId: adminId,
      action: "displayName.hide",
      targetType: "user",
      targetId: a,
      metadata: { name: "rude.name" },
    });
  });

  it("says when there's no name to hide, and logs nothing", async () => {
    const a = await labeler(null, false, 300);
    expect(await hide({ userId: a })).toEqual({ status: 404, body: { error: "no_name" } });
    expect(await hide({})).toEqual({ status: 400, body: { error: "invalid" } });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("is for super admins only", async () => {
    const a = await labeler("rude.name", true, 300);
    as("CUSTOMER");
    expect((await hide({ userId: a })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: a } })).displayName).toBe("rude.name");
  });
});
