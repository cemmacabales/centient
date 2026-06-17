import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/auth/me/route";
import { signLabelerJWT } from "@/lib/labeler-auth";

const TEST_WALLET = "0xme0000000000000000000000000000000000me00";

function makeReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) {
    headers.cookie = `labeler_session=${token}`;
  }
  return new NextRequest("http://localhost/api/auth/me", { headers });
}

describe("GET /api/auth/me", () => {
  it("returns authenticated false when no cookie is present", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("returns authenticated true with wallet when cookie is valid", async () => {
    const token = await signLabelerJWT(TEST_WALLET);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      wallet: TEST_WALLET,
    });
  });

  it("returns authenticated false for a tampered token", async () => {
    const req = makeReq("not.a.valid.jwt");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});
