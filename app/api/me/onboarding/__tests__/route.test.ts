import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: vi.fn() };
});

import { POST } from "@/app/api/me/onboarding/route";
import { getLabelerSession } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, makeWallet } from "@/tests/helpers/factories";

function makeReq(body: unknown): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/me/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(getLabelerSession).mockReset();
});

describe("POST /api/me/onboarding", () => {
  it("returns 401 when no session cookie is present", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(null);
    const res = await POST(
      makeReq({ country: "PH", ageRange: "25-34" })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 for invalid JSON body", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(makeWallet());
    const req = new NextRequest("http://localhost/api/me/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 when country is missing", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(makeWallet());
    const res = await POST(makeReq({ ageRange: "25-34" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_required_fields",
      message: "country and ageRange are required",
    });
  });

  it("returns 400 when ageRange is missing", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(makeWallet());
    const res = await POST(makeReq({ country: "PH" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_required_fields",
      message: "country and ageRange are required",
    });
  });

  it("returns 400 for invalid country code", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(makeWallet());
    const res = await POST(
      makeReq({ country: "XX", ageRange: "25-34" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_country" });
  });

  it("returns 400 for invalid age range", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(makeWallet());
    const res = await POST(
      makeReq({ country: "PH", ageRange: "0-10" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_age_range" });
  });

  it("returns 400 for invalid gender", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(makeWallet());
    const res = await POST(
      makeReq({ country: "PH", ageRange: "25-34", gender: "other" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_gender" });
  });

  it("completes onboarding for a new wallet", async () => {
    const wallet = makeWallet();
    vi.mocked(getLabelerSession).mockResolvedValue(wallet);
    const res = await POST(
      makeReq({ country: "PH", ageRange: "25-34", gender: "male" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const user = await prisma.user.findUnique({
      where: { walletAddress: wallet },
    });
    expect(user).not.toBeNull();
    expect(user!.country).toBe("PH");
    expect(user!.ageRange).toBe("25-34");
    expect(user!.gender).toBe("male");
    expect(user!.onboardingCompleted).toBe(true);
  });

  it("returns 409 when onboarding is already completed", async () => {
    const wallet = makeWallet();
    await createUser({ walletAddress: wallet });
    await prisma.user.update({
      where: { walletAddress: wallet },
      data: {
        onboardingCompleted: true,
        country: "US",
        ageRange: "25-34",
      },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(wallet);
    const res = await POST(
      makeReq({ country: "PH", ageRange: "35-44" })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "onboarding_already_completed",
    });
  });

  it("ignores wallet in request body and uses session wallet", async () => {
    const wallet = makeWallet();
    vi.mocked(getLabelerSession).mockResolvedValue(wallet);
    const res = await POST(
      makeReq({
        wallet: "0x000000000000000000000000000000000000DEAD",
        country: "PH",
        ageRange: "25-34",
      })
    );
    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({
      where: { walletAddress: wallet },
    });
    expect(user).not.toBeNull();
    const spoofed = await prisma.user.findUnique({
      where: { walletAddress: "0x000000000000000000000000000000000000dead" },
    });
    expect(spoofed).toBeNull();
  });

  it("allows onboarding without gender", async () => {
    const wallet = makeWallet();
    vi.mocked(getLabelerSession).mockResolvedValue(wallet);
    const res = await POST(
      makeReq({ country: "PH", ageRange: "25-34" })
    );
    expect(res.status).toBe(200);
  });

  it("accepts 'prefer_not_to_say' as valid gender", async () => {
    const wallet = makeWallet();
    vi.mocked(getLabelerSession).mockResolvedValue(wallet);
    const res = await POST(
      makeReq({
        country: "PH",
        ageRange: "25-34",
        gender: "prefer_not_to_say",
      })
    );
    expect(res.status).toBe(200);
  });
});
