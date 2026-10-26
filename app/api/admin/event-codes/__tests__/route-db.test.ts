// #203 — the admin's event codes: super admins only, validated, audit-logged.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return { ...actual, getAdminSession: vi.fn() };
});

import { GET, POST } from "@/app/api/admin/event-codes/route";
import { auditLog } from "@/lib/audit";
import { getAdminSession, type AdminJWTPayload } from "@/lib/admin-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createAdminUser } from "@/tests/helpers/factories";

let adminId: string;

const as = (role: "SUPER_ADMIN" | "CUSTOMER") =>
  vi.mocked(getAdminSession).mockResolvedValue({ sub: adminId, email: "a@b.co", role, companyName: null } as AdminJWTPayload);

beforeEach(async () => {
  await truncateAll();
  vi.mocked(auditLog).mockReset();
  adminId = (await createAdminUser({ role: "SUPER_ADMIN" })).id;
  as("SUPER_ADMIN");
});

const good = { code: "webinar1", stampTitle: "Contributor webinar", stampIcon: "podcasts", startsDay: "2026-10-15", endsDay: "2026-10-16" };

async function create(body: unknown) {
  const res = await POST(new NextRequest("http://localhost/api/admin/event-codes", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

describe("POST /api/admin/event-codes", () => {
  it("creates a code, uppercase, and audit-logs it", async () => {
    const res = await create(good);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: "WEBINAR1", stampTitle: "Contributor webinar", redeemed: 0 });
    const row = await prisma.eventCode.findUniqueOrThrow({ where: { code: "WEBINAR1" } });
    expect(vi.mocked(auditLog).mock.calls[0][0]).toMatchObject({
      adminUserId: adminId,
      action: "eventCode.create",
      targetType: "eventCode",
      targetId: row.id,
      metadata: { code: "WEBINAR1", stampTitle: "Contributor webinar", startsDay: "2026-10-15", endsDay: "2026-10-16" },
    });
  });

  it("names the field that's wrong, and writes nothing", async () => {
    expect(await create({ ...good, endsDay: "2026-10-14" })).toEqual({ status: 400, body: { error: "invalid", field: "endsDay" } });
    expect(await create({ ...good, stampIcon: "skull" })).toEqual({ status: 400, body: { error: "invalid", field: "stampIcon" } });
    expect(await prisma.eventCode.count()).toBe(0);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("refuses a code that exists", async () => {
    await create(good);
    expect(await create({ ...good, code: "WEBINAR1" })).toEqual({ status: 409, body: { error: "code_taken" } });
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it("is for super admins only", async () => {
    as("CUSTOMER");
    expect((await create(good)).status).toBe(403);
    vi.mocked(getAdminSession).mockResolvedValue(null);
    expect((await create(good)).status).toBe(401);
    expect(await prisma.eventCode.count()).toBe(0);
  });
});

describe("GET /api/admin/event-codes", () => {
  it("lists codes with their redemptions", async () => {
    await create(good);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ codes: [{ code: "WEBINAR1", redeemed: 0 }] });
  });

  it("is for super admins only", async () => {
    as("CUSTOMER");
    expect((await GET()).status).toBe(403);
  });
});
