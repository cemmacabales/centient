// #203 — PATCH /api/me/profile: the labeler's board name and "Show my name".
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gamification/server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { PATCH } from "@/app/api/me/profile/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

let userId: string;

beforeEach(async () => {
  await truncateAll();
  userId = (await createUser()).id;
});

async function patch(body: unknown, as: string | null = userId) {
  const headers: Record<string, string> = {};
  if (as) headers.cookie = `labeler_session=${await signLabelerJWT(as)}`;
  const res = await PATCH(new NextRequest("http://localhost/api/me/profile", { method: "PATCH", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

describe("PATCH /api/me/profile", () => {
  it("needs a session", async () => {
    expect((await patch({ showOnBoard: false }, null)).status).toBe(401);
  });

  it("saves a name and shows it", async () => {
    expect(await patch({ displayName: "Tala.Labels", showOnBoard: true })).toEqual({
      status: 200,
      body: { displayName: "tala.labels", showOnBoard: true, nameHidden: false },
    });
  });

  it("says why a name can't be used", async () => {
    const other = (await createUser()).id;
    await patch({ displayName: "tala.labels" }, other);
    expect(await patch({ displayName: "tala.labels" })).toEqual({ status: 409, body: { error: "name_taken" } });
    expect(await patch({ displayName: "admin" })).toEqual({ status: 400, body: { error: "not_allowed" } });
    expect(await patch({ showOnBoard: true })).toEqual({ status: 400, body: { error: "name_required" } });
  });

  it("refuses a body that isn't an object", async () => {
    expect(await patch(null)).toEqual({ status: 400, body: { error: "invalid" } });
  });
});
