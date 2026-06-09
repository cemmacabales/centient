import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/auth/nonce/route";
import { prisma, truncateAll } from "@/tests/helpers/db";

function makeReq(address: string): NextRequest {
  return new NextRequest(`http://localhost/api/auth/nonce?address=${address}`);
}

beforeEach(async () => {
  await truncateAll();
});

describe("GET /api/auth/nonce", () => {
  it("returns 400 when address is missing", async () => {
    const req = new NextRequest("http://localhost/api/auth/nonce");
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_wallet" });
  });

  it("returns 400 when address is invalid", async () => {
    const res = await GET(makeReq("not-a-wallet"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_wallet" });
  });

  it("returns a nonce for a valid wallet", async () => {
    const addr = "0x0000000000000000000000000000000000000001";
    const res = await GET(makeReq(addr));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.nonce).toBe("string");
    expect(body.nonce.length).toBeGreaterThan(0);
  });

  it("stores the nonce in the database", async () => {
    const addr = "0x00000000000000000000000000000000000000aa";
    const res = await GET(makeReq(addr));
    const body = await res.json();
    const record = await prisma.walletNonce.findFirst({
      where: { walletAddress: addr, nonce: body.nonce },
    });
    expect(record).not.toBeNull();
    expect(record!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reuses the same wallet address and replaces old nonce", async () => {
    const addr = "0x00000000000000000000000000000000000000bb";
    const res1 = await GET(makeReq(addr));
    const body1 = await res1.json();
    const res2 = await GET(makeReq(addr));
    const body2 = await res2.json();
    expect(body1.nonce).not.toBe(body2.nonce);
    const oldRecord = await prisma.walletNonce.findFirst({
      where: { walletAddress: addr, nonce: body1.nonce },
    });
    expect(oldRecord).toBeNull();
    const newRecord = await prisma.walletNonce.findFirst({
      where: { walletAddress: addr, nonce: body2.nonce },
    });
    expect(newRecord).not.toBeNull();
  });

  it("normalizes address to lowercase", async () => {
    const upperAddr = "0x00000000000000000000000000000000000000CC";
    const res = await GET(makeReq(upperAddr));
    expect(res.status).toBe(200);
    const record = await prisma.walletNonce.findFirst({
      where: { walletAddress: upperAddr.toLowerCase() },
    });
    expect(record).not.toBeNull();
  });
});
