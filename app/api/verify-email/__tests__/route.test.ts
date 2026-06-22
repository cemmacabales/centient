import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/verify-email/route";
import { prisma, truncateAll } from "@/tests/helpers/db";

function makeReq(body: unknown): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/verify-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

async function seedUnverifiedUser(token: string, expires: Date) {
  return prisma.user.create({
    data: {
      email: `labeler-${token.slice(0, 8)}@example.com`,
      passwordHash: "hashed",
      isVerified: false,
      verificationToken: token,
      verificationTokenExpires: expires,
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await truncateAll();
});

describe("POST /api/verify-email (labeler user)", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 when token is missing", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_token" });
  });

  it("returns 400 for an unknown token", async () => {
    const res = await POST(makeReq({ token: "does-not-exist" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("verifies a labeler user and clears the token", async () => {
    const token = "a".repeat(64);
    const user = await seedUnverifiedUser(token, new Date(Date.now() + 60_000));
    const res = await POST(makeReq({ token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: "Email verified successfully",
    });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated!.isVerified).toBe(true);
    expect(updated!.verifiedAt).not.toBeNull();
    expect(updated!.verificationToken).toBeNull();
    expect(updated!.verificationTokenExpires).toBeNull();
  });

  it("returns 400 when the labeler user token has expired", async () => {
    const token = "b".repeat(64);
    const user = await seedUnverifiedUser(token, new Date(Date.now() - 1000));
    const res = await POST(makeReq({ token }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated!.isVerified).toBe(false);
  });
});
