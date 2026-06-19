import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";

vi.mock("@/lib/rate-limit", () => ({
  isLoginRateLimited: vi.fn(async () => false),
  recordLoginFailure: vi.fn(async () => {}),
  resetLoginFailures: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/auth/login/route";
import {
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginFailures,
} from "@/lib/rate-limit";
import { verifyLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";

const EMAIL = "labeler@example.com";
const PASSWORD = "Password1!";

function makeReq(body: unknown): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

async function seedUser(overrides: { isVerified?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      isVerified: overrides.isVerified ?? true,
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(isLoginRateLimited).mockReset().mockResolvedValue(false);
  vi.mocked(recordLoginFailure).mockReset().mockResolvedValue(undefined);
  vi.mocked(resetLoginFailures).mockReset().mockResolvedValue(undefined);
});

describe("POST /api/auth/login", () => {
  it("returns 429 when rate limited", async () => {
    vi.mocked(isLoginRateLimited).mockResolvedValue(true);
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("logs in a verified user and issues a userId session", async () => {
    const user = await seedUser({ isVerified: true });
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, userId: user.id });

    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("labeler_session="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/);
    const token = cookie!.split(";")[0].split("=")[1];
    const payload = await verifyLabelerJWT(token);
    expect(payload?.sub).toBe(user.id);

    expect(resetLoginFailures).toHaveBeenCalled();
  });

  it("normalizes the email when looking up the user", async () => {
    const user = await seedUser({ isVerified: true });
    const res = await POST(makeReq({ email: "Labeler@Example.COM", password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, userId: user.id });
  });

  it("returns generic invalid_credentials for an unknown email", async () => {
    const res = await POST(makeReq({ email: "ghost@example.com", password: PASSWORD }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
    expect(recordLoginFailure).toHaveBeenCalled();
  });

  it("returns generic invalid_credentials for a wrong password", async () => {
    await seedUser({ isVerified: true });
    const res = await POST(makeReq({ email: EMAIL, password: "WrongPass1!" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
    expect(recordLoginFailure).toHaveBeenCalled();
  });

  it("rejects login for an unverified email (only with correct password)", async () => {
    await seedUser({ isVerified: false });
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "email_not_verified" });
  });

  it("keys the rate limiter on x-real-ip and ignores forgeable x-forwarded-for", async () => {
    const req = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Attacker-supplied; must not be used for rate-limit keying.
        "x-forwarded-for": "1.2.3.4",
        // Set by the trusted proxy; this is what we must key on.
        "x-real-ip": "10.0.0.9",
      },
      body: JSON.stringify({ email: "ghost@example.com", password: PASSWORD }),
    });
    await POST(req);
    expect(isLoginRateLimited).toHaveBeenCalledWith("10.0.0.9");
    expect(recordLoginFailure).toHaveBeenCalledWith("10.0.0.9");
  });

  it("returns invalid_credentials for a wallet-only user with no password", async () => {
    await prisma.user.create({
      data: { email: EMAIL, walletAddress: "0xabc0000000000000000000000000000000000abc" },
    });
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });
});
