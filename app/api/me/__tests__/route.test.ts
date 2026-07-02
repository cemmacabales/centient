import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/me/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

function makeReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `labeler_session=${token}`;
  return new NextRequest("http://localhost/api/me", { headers });
}

beforeEach(async () => {
  await truncateAll();
});

describe("GET /api/me", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 401 for a tampered token", async () => {
    const res = await GET(makeReq("not.a.valid.jwt"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session user no longer exists", async () => {
    const token = await signLabelerJWT("00000000-0000-0000-0000-000000000000");
    const res = await GET(makeReq(token));
    expect(res.status).toBe(401);
  });

  it("returns the profile for an email-only user with no linked wallet", async () => {
    const user = await createUser({ walletAddress: null, email: "labeler@example.com" });
    await prisma.user.update({
      where: { id: user.id },
      data: { submissionCount: 3, onboardingCompleted: true, totalEarnedUnits: 1500000n },
    });

    const token = await signLabelerJWT(user.id);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.walletAddress).toBeNull();
    expect(body.submissionCount).toBe(3);
    expect(body.onboardingCompleted).toBe(true);
    expect(body.totalEarned).toBe("0.15");
    expect(body.rewardSymbol).toBe("USDC");
    expect(body.isBanned).toBe(false);
  });

  it("returns the linked wallet when the account has one", async () => {
    const user = await createUser({ walletAddress: "0x1111111111111111111111111111111111111111" });
    const token = await signLabelerJWT(user.id);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.walletAddress).toBe("0x1111111111111111111111111111111111111111");
  });

  it("reflects cooldown state for a temporarily banned user", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await createUser({ isBanned: true, banCount: 1, bannedUntil: future });
    const token = await signLabelerJWT(user.id);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isBanned).toBe(true);
    expect(body.isCooldown).toBe(true);
    expect(body.unbannedAt).toBe(future.toISOString());
  });
});
