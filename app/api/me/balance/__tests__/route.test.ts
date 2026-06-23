import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/me/balance/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

function makeReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) {
    headers.cookie = `labeler_session=${token}`;
  }
  return new NextRequest("http://localhost/api/me/balance", { headers });
}

beforeEach(async () => {
  await truncateAll();
});

describe("GET /api/me/balance", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
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

  it("returns the pending balance and recent ledger entries (most recent first)", async () => {
    const user = await createUser({ pendingBalanceWei: 150000000000000000n });
    await prisma.userBalanceLedger.create({
      data: { userId: user.id, type: "CREDIT_REWARD", amountWei: 50000000000000000n, submissionId: "sub-1" },
    });
    await prisma.userBalanceLedger.create({
      data: { userId: user.id, type: "CREDIT_REWARD", amountWei: 100000000000000000n, submissionId: "sub-2" },
    });

    const token = await signLabelerJWT(user.id);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pendingBalanceWei).toBe("150000000000000000");
    expect(body.pendingBalance).toBe("0.15");
    expect(body.rewardSymbol).toBe("cUSD");

    expect(body.ledger).toHaveLength(2);
    expect(body.ledger[0].submissionId).toBe("sub-2");
    expect(body.ledger[0].type).toBe("CREDIT_REWARD");
    expect(body.ledger[0].amountWei).toBe("100000000000000000");
    expect(body.ledger[0].amount).toBe("0.1");
    expect(typeof body.ledger[0].createdAt).toBe("string");
  });

  it("returns a zero balance and empty ledger for a new user", async () => {
    const user = await createUser({});
    const token = await signLabelerJWT(user.id);
    const res = await GET(makeReq(token));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pendingBalanceWei).toBe("0");
    expect(body.pendingBalance).toBe("0");
    expect(body.ledger).toEqual([]);
  });

  it("only returns the session user's own ledger entries", async () => {
    const me = await createUser({ pendingBalanceWei: 50000000000000000n });
    const other = await createUser({ pendingBalanceWei: 999000000000000000n });
    await prisma.userBalanceLedger.create({
      data: { userId: me.id, type: "CREDIT_REWARD", amountWei: 50000000000000000n, submissionId: "mine" },
    });
    await prisma.userBalanceLedger.create({
      data: { userId: other.id, type: "CREDIT_REWARD", amountWei: 999000000000000000n, submissionId: "theirs" },
    });

    const token = await signLabelerJWT(me.id);
    const res = await GET(makeReq(token));
    const body = await res.json();
    expect(body.pendingBalanceWei).toBe("50000000000000000");
    expect(body.ledger).toHaveLength(1);
    expect(body.ledger[0].submissionId).toBe("mine");
  });
});
