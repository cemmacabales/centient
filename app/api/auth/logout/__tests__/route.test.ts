import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/auth/logout/route";
import { signLabelerJWT } from "@/lib/labeler-auth";

function makeReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) {
    headers.cookie = `labeler_session=${token}`;
  }
  return new NextRequest("http://localhost/api/auth/logout", { headers });
}

describe("POST /api/auth/logout", () => {
  it("redirects to / and clears the labeler_session cookie", async () => {
    const token = await signLabelerJWT("00000000-0000-0000-0000-000000000000");
    const res = await POST(makeReq(token));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/");
    expect(res.cookies.get("labeler_session")?.value).toBe("");
  });

  it("redirects to / even when no session cookie is present", async () => {
    const res = await POST(makeReq());

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/");
  });
});
