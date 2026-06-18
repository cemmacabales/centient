import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/audit", () => ({
  auditLog: vi.fn(),
}));

vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return {
    ...actual,
    getAdminSession: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkExportRateLimit: vi.fn(async () => false),
  };
});

import { GET } from "@/app/api/admin/export/route";
import { getAdminSession } from "@/lib/admin-auth";
import { checkExportRateLimit } from "@/lib/rate-limit";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createAdminUser, createCampaign, createTask, createUser, makeWallet } from "@/tests/helpers/factories";
import type { AdminJWTPayload } from "@/lib/admin-auth";

function makeReq(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/admin/export");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

function mockSession(overrides: Partial<AdminJWTPayload> = {}): AdminJWTPayload {
  return {
    sub: "admin-test-id",
    email: "admin@test.com",
    role: "SUPER_ADMIN",
    companyName: null,
    ...overrides,
  } as AdminJWTPayload;
}

async function createSentSubmission(
  campaignId: string,
  overrides: { choice?: "A" | "B"; category?: string } = {},
) {
  const wallet = makeWallet();
  const user = await createUser({ walletAddress: wallet });
  const task = await createTask({
    campaignId,
    category: overrides.category ?? null,
  });
  const sub = await prisma.submission.create({
    data: {
      walletAddress: wallet,
      userId: user.id,
      taskId: task.id,
      choice: overrides.choice ?? "A",
      reason: "Test reason that is long enough for validation",
      payoutAmountWei: 1000000000000000n,
      payoutStatus: "sent",
      isGoldCheck: false,
    },
  });
  return { submission: sub, task, wallet };
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(getAdminSession).mockReset();
  vi.mocked(checkExportRateLimit).mockReset();
  vi.mocked(checkExportRateLimit).mockResolvedValue(false);
});

function parseJsonl(text: string): unknown[] {
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("GET /api/admin/export - auth", () => {
  it("returns 401 when no session", async () => {
    vi.mocked(getAdminSession).mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 when CUSTOMER role and no campaignId", async () => {
    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "CUSTOMER", sub: "customer-1" }));
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_campaign_id",
      message: "?campaignId is required for CUSTOMER role",
    });
  });

  it("returns 403 when CUSTOMER role and campaignId belongs to another customer", async () => {
    const otherAdmin = await createAdminUser({ role: "CUSTOMER" });
    const campaign = await createCampaign({ adminUserId: otherAdmin.id });

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "CUSTOMER", sub: "customer-1" }));
    const res = await GET(makeReq({ campaignId: campaign.id }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("returns 200 when CUSTOMER role and valid campaignId", async () => {
    const campaign = await createCampaign();
    const { submission: sub1 } = await createSentSubmission(campaign.id);

    vi.mocked(getAdminSession).mockResolvedValue(
      mockSession({ role: "CUSTOMER", sub: campaign.adminUserId }),
    );
    const res = await GET(makeReq({ campaignId: campaign.id }));
    expect(res.status).toBe(200);

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
    expect((records[0] as Record<string, unknown>).id).toBe(sub1.id);
  });

  it("returns 200 when SUPER_ADMIN role (global export)", async () => {
    const campaign = await createCampaign();
    const { submission: sub1 } = await createSentSubmission(campaign.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
    expect((records[0] as Record<string, unknown>).id).toBe(sub1.id);
  });

  it("returns 200 when SUPER_ADMIN role with campaignId filter", async () => {
    const admin1 = await createAdminUser({ email: "campaign1@test.com" });
    const campaign1 = await createCampaign({ adminUserId: admin1.id });
    const admin2 = await createAdminUser({ email: "campaign2@test.com" });
    const campaign2 = await createCampaign({ adminUserId: admin2.id });
    const { submission: sub1 } = await createSentSubmission(campaign1.id);
    await createSentSubmission(campaign2.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq({ campaignId: campaign1.id }));
    expect(res.status).toBe(200);

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
    expect((records[0] as Record<string, unknown>).id).toBe(sub1.id);
  });
});

describe("GET /api/admin/export - campaign scoping", () => {
  it("CUSTOMER only sees their own campaign submissions", async () => {
    const admin1 = await createAdminUser({ email: "customer-a@test.com" });
    const campaign1 = await createCampaign({ adminUserId: admin1.id });
    const admin2 = await createAdminUser({ email: "customer-b@test.com" });
    const campaign2 = await createCampaign({ adminUserId: admin2.id });
    await createSentSubmission(campaign1.id);
    await createSentSubmission(campaign2.id);

    vi.mocked(getAdminSession).mockResolvedValue(
      mockSession({ role: "CUSTOMER", sub: campaign1.adminUserId }),
    );
    const res = await GET(makeReq({ campaignId: campaign1.id }));
    expect(res.status).toBe(200);

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
  });

  it("SUPER_ADMIN global sees submissions from all campaigns", async () => {
    const admin1 = await createAdminUser({ email: "global1@test.com" });
    const campaign1 = await createCampaign({ adminUserId: admin1.id });
    const admin2 = await createAdminUser({ email: "global2@test.com" });
    const campaign2 = await createCampaign({ adminUserId: admin2.id });
    await createSentSubmission(campaign1.id);
    await createSentSubmission(campaign2.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(2);
  });

  it("SUPER_ADMIN with campaignId sees only that campaign", async () => {
    const admin1 = await createAdminUser({ email: "scoped1@test.com" });
    const campaign1 = await createCampaign({ adminUserId: admin1.id });
    const admin2 = await createAdminUser({ email: "scoped2@test.com" });
    const campaign2 = await createCampaign({ adminUserId: admin2.id });
    await createSentSubmission(campaign1.id);
    await createSentSubmission(campaign2.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq({ campaignId: campaign1.id }));
    expect(res.status).toBe(200);

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
  });
});

describe("GET /api/admin/export - rate limiting", () => {
  it("returns 429 when rate limited", async () => {
    const campaign = await createCampaign();
    await createSentSubmission(campaign.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    vi.mocked(checkExportRateLimit).mockResolvedValue(true);

    const res = await GET(makeReq());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});

describe("GET /api/admin/export - format validation", () => {
  it("returns 400 for invalid format", async () => {
    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq({ format: "xml" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_format",
      message: "?format must be json, csv, or txt",
    });
  });

  it("returns 400 for invalid split", async () => {
    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq({ split: "dev" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_split",
      message: "?split must be train, test, validation, or all",
    });
  });

  it("returns CSV format with correct Content-Type", async () => {
    const campaign = await createCampaign();
    await createSentSubmission(campaign.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq({ format: "csv" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv");

    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toContain("prompt");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("returns TXT format with correct Content-Type", async () => {
    const campaign = await createCampaign();
    await createSentSubmission(campaign.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq({ format: "txt" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");

    const text = await res.text();
    expect(text).toContain("--- Record 1 ---");
    expect(text).toContain("Prompt:");
  });

  it("returns JSONL by default", async () => {
    const campaign = await createCampaign();
    const { submission: sub1 } = await createSentSubmission(campaign.id);

    vi.mocked(getAdminSession).mockResolvedValue(mockSession({ role: "SUPER_ADMIN" }));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");

    const records = parseJsonl(await res.text());
    expect(records).toHaveLength(1);
    expect((records[0] as Record<string, unknown>).id).toBe(sub1.id);
  });
});
