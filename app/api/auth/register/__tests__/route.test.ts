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
    expect(res.status).toBe(200);
    const json = await res.json();
    // Non-enumerating: response reveals nothing about the account itself.
    expect(json.message).toMatch(/check your inbox/i);
    expect(json.user).toBeUndefined();

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
    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).not.toBeNull();
  });

  it("returns a generic non-enumerating response for a duplicate email", async () => {
    const first = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    const second = await POST(makeReq({ email: EMAIL, password: PASSWORD }));

    // The duplicate response is identical to the new-registration response so it
    // cannot be used to probe which emails are registered.
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());

    // No second account was created and no verification email was re-sent.
    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("returns the generic response even when the verification email fails to send", async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error("smtp down"));
    const res = await POST(makeReq({ email: EMAIL, password: PASSWORD }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/check your inbox/i);
    const user = await prisma.user.findUnique({ where: { email: EMAIL } });
    expect(user).not.toBeNull();
  });
});
