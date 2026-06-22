import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/auth/me/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

function makeReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) {
    headers.cookie = `labeler_session=${token}`;
  }
  return new NextRequest("http://localhost/api/auth/me", { headers });
}

beforeEach(async () => {
  await truncateAll();
});

describe("GET /api/auth/me", () => {
  it("returns authenticated false when no cookie is present", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("returns the user identity (incl. wallet) when cookie is valid", async () => {
    const user = await createUser({});
    const token = await signLabelerJWT(user.id);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      userId: user.id,
      wallet: user.walletAddress,
      email: null,
      isVerified: false,
    });
  });

  it("returns authenticated false when the user no longer exists", async () => {
    const token = await signLabelerJWT("00000000-0000-0000-0000-000000000000");
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("returns authenticated false for a tampered token", async () => {
    const res = await GET(makeReq("not.a.valid.jwt"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});
