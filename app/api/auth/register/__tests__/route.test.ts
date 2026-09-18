import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/email", () => ({
  sendVerificationEmail: vi.fn(async () => true),
}));

import { POST } from "@/app/api/auth/register/route";
import { sendVerificationEmail } from "@/lib/email";
import { prisma, truncateAll } from "@/tests/helpers/db";

beforeEach(async () => {
  await truncateAll();
  vi.mocked(sendVerificationEmail).mockClear();
});

describe("POST /api/auth/register — retired (#30)", () => {
  it("answers 410 email_registration_retired", async () => {
    const res = await POST();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "email_registration_retired" });
  });

  it("creates no account and sends no email", async () => {
    await POST();
    expect(await prisma.user.count()).toBe(0);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});
