// #202 — the campaign crowd: Campaign.minTier on GET and PATCH, the count of
// labelers each option reaches, and `labeler_tier` in the campaign export.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return { ...actual, getAdminSession: vi.fn() };
});

import { GET, PATCH } from "@/app/api/admin/campaigns/[id]/route";
import { GET as EXPORT } from "@/app/api/admin/campaigns/[id]/export/route";
import { getAdminSession, type AdminJWTPayload } from "@/lib/admin-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createAdminUser, createCampaign, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

let campaignId: string;

beforeEach(async () => {
  await truncateAll();
  const admin = await createAdminUser({ role: "SUPER_ADMIN" });
  vi.mocked(getAdminSession).mockResolvedValue({ sub: admin.id, email: admin.email, role: "SUPER_ADMIN", companyName: null } as AdminJWTPayload);
  campaignId = (await createCampaign({ adminUserId: admin.id })).id;
});

const params = () => ({ params: Promise.resolve({ id: campaignId }) });

async function patch(body: unknown) {
  const res = await PATCH(
    new NextRequest(`http://localhost/api/admin/campaigns/${campaignId}`, { method: "PATCH", body: JSON.stringify(body) }),
    params(),
  );
  return { status: res.status, body: await res.json() };
}

describe("PATCH /api/admin/campaigns/[id] - minTier (#202)", () => {
  it.each([0, 1, 2])("accepts %i", async (minTier) => {
    if (minTier === 0) await prisma.campaign.update({ where: { id: campaignId }, data: { minTier: 1 } });
    const res = await patch({ minTier });
    expect(res.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).minTier).toBe(minTier);
  });

  it.each([3, -1, 1.5, "1", null])("rejects %s: Expert-only campaigns come later", async (minTier) => {
    const res = await patch({ minTier });
    expect(res).toEqual({ status: 400, body: { error: "invalid_min_tier" } });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).minTier).toBe(0);
  });
});

describe("GET /api/admin/campaigns/[id] - crowd (#202)", () => {
  it("returns minTier and how many labelers each option reaches", async () => {
    await prisma.campaign.update({ where: { id: campaignId }, data: { minTier: 1 } });
    const set = async (tier: number, tierOnHold = false, isBanned = false) => {
      const u = await createUser({ isBanned });
      await prisma.user.update({ where: { id: u.id }, data: { tier, tierOnHold } });
    };
    await set(0);
    await set(1);
    await set(2);
    await set(2, true); // Held Trusted is served Skilled's tasks.
    await set(3);
    await set(3, false, true); // Banned: reaches nothing.
    await createUser({ walletAddress: null, email: "e@x.com" }); // No wallet: can't be served.

    const res = await GET(new Request(`http://localhost/api/admin/campaigns/${campaignId}`), params());
    const body = await res.json();
    expect(body.minTier).toBe(1);
    expect(body.qualifyingLabelers).toEqual({ 0: 5, 1: 4, 2: 2 });
  });
});

describe("GET /api/admin/campaigns/[id]/export - labeler_tier (#202)", () => {
  async function answered(labelerTier: number | null) {
    const user = await createUser();
    const task = await createTask({ campaignId, prompt: `Prompt ${labelerTier}?` });
    await prisma.submission.create({
      data: { userId: user.id, walletAddress: user.walletAddress, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1n, payoutStatus: "sent", labelerTier },
    });
  }

  const exportAs = async (format: string) =>
    (await EXPORT(new NextRequest(`http://localhost/api/admin/campaigns/${campaignId}/export?format=${format}`), params())).text();

  it("adds the tier when answered to the CSV, empty before tiers", async () => {
    await answered(2);
    await answered(null);
    const [header, ...rows] = (await exportAs("csv")).trim().split("\n");
    const col = header.split(",").indexOf("labeler_tier");
    expect(col).toBe(header.split(",").indexOf("labeler") + 1);
    expect(rows.map((r) => r.split(",")[col]).sort()).toEqual(["", "Trusted"]);
  });

  it("adds it to JSON lines and text", async () => {
    await answered(1);
    expect(JSON.parse((await exportAs("json")).trim()).labeler_tier).toBe("Skilled");
    expect(await exportAs("txt")).toContain("Labeler tier: Skilled");
  });
});
