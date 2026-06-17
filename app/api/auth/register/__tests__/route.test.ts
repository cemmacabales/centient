import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/email", () => ({
  sendVerificationEmail: vi.fn(async () => true),
}));

import { POST } from "@/app/api/auth/register/route";
import { sendVerificationEmail } from "@/lib/email";
import { prisma, truncateAll } from "@/tests/helpers/db";

const EMAIL = "labeler@example.com";
const PASSWORD = "Password1!";

function makeReq(body: unknown): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(sendVerificationEmail).mockReset();
  vi.mocked(sendVerificationEmail).mockResolvedValue(true as never);
});

describe("POST /api/auth/register", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 when fields are missing", async () => {
    const res = await POST(makeReq({ email: EMAIL }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
  });

  it("returns 400 for an invalid email", async () => {
    const res = await POST(makeReq({ email: "nope", password: PASSWORD }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("returns 400 for a weak password", async () => {
    const res = await POST(makeReq({ email: EMAIL, password: "short" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "weak_password" });
  });

  it("registers a new user, hashes the password, and sends verification", async () => {
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.user.email).toBe(EMAIL);
    expect(json.user.isVerified).toBe(false);
    expect(json.emailDelivered).toBe(true);

    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).not.toBeNull();
    expect(user!.passwordHash).toBeTruthy();
    expect(user!.passwordHash).not.toBe(PASSWORD);
    expect(user!.isVerified).toBe(false);
    expect(user!.verificationToken).toBeTruthy();
    expect(user!.verificationTokenExpires!.getTime()).toBeGreaterThan(Date.now());

    expect(sendVerificationEmail).toHaveBeenCalledWith(EMAIL, user!.verificationToken);
  });

  it("normalizes the email to lowercase", async () => {
    const res = await POST(makeReq({ email: "Labeler@Example.COM", password: PASSWORD }));
    expect(res.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).not.toBeNull();
  });

  it("returns 409 for a duplicate email", async () => {
    await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_exists" });
  });

  it("still creates the user but reports emailDelivered false when sending fails", async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error("smtp down"));
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.emailDelivered).toBe(false);
    expect(json.warning).toBeTruthy();
    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).not.toBeNull();
  });
});
