import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, recoverMessageAddress: vi.fn() };
});

import { POST } from "@/app/api/auth/verify/route";
import { recoverMessageAddress } from "viem";
import { prisma, truncateAll } from "@/tests/helpers/db";

const TEST_WALLET = "0xdead00000000000000000000000000000000beef";
const TEST_NONCE = "testnonce123";

function makeReq(
  body: { address?: string; signature?: string; nonce?: string } = {}
): NextRequest {
  return new NextRequest("http://localhost/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(recoverMessageAddress).mockReset();
});

describe("POST /api/auth/verify", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("returns 400 when address is missing", async () => {
    const res = await POST(makeReq({ signature: "0x00", nonce: "abc" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_wallet" });
  });

  it("returns 400 when signature is missing", async () => {
    const res = await POST(makeReq({ address: TEST_WALLET, nonce: "abc" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
  });

  it("returns 400 when nonce is missing", async () => {
    const res = await POST(
      makeReq({ address: TEST_WALLET, signature: "0x1234" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_nonce" });
  });

  it("returns 401 when nonce record does not exist", async () => {
    vi.mocked(recoverMessageAddress).mockResolvedValue(TEST_WALLET);
    const res = await POST(
      makeReq({
        address: TEST_WALLET,
        signature: "0x" + "ab".repeat(65),
        nonce: "nonexistent",
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "nonce_not_found" });
  });

  it("returns 401 when nonce has expired", async () => {
    await prisma.walletNonce.create({
      data: {
        walletAddress: TEST_WALLET,
        nonce: TEST_NONCE,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    vi.mocked(recoverMessageAddress).mockResolvedValue(TEST_WALLET);
    const res = await POST(
      makeReq({
        address: TEST_WALLET,
        signature: "0x" + "ab".repeat(65),
        nonce: TEST_NONCE,
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "nonce_expired" });
  });

  it("returns 401 when signature verification fails", async () => {
    await prisma.walletNonce.create({
      data: {
        walletAddress: TEST_WALLET,
        nonce: TEST_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    vi.mocked(recoverMessageAddress).mockRejectedValue(new Error("bad sig"));
    const res = await POST(
      makeReq({
        address: TEST_WALLET,
        signature: "0x" + "ab".repeat(65),
        nonce: TEST_NONCE,
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "signature_verification_failed",
    });
  });

  it("returns 401 when recovered address does not match wallet", async () => {
    await prisma.walletNonce.create({
      data: {
        walletAddress: TEST_WALLET,
        nonce: TEST_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    vi.mocked(recoverMessageAddress).mockResolvedValue(
      "0x0000000000000000000000000000000000000999"
    );
    const res = await POST(
      makeReq({
        address: TEST_WALLET,
        signature: "0x" + "ab".repeat(65),
        nonce: TEST_NONCE,
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signature_mismatch" });
  });

  it("returns 200 and sets session cookie on success", async () => {
    await prisma.walletNonce.create({
      data: {
        walletAddress: TEST_WALLET,
        nonce: TEST_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    vi.mocked(recoverMessageAddress).mockResolvedValue(TEST_WALLET);
    const res = await POST(
      makeReq({
        address: TEST_WALLET,
        signature: "0x" + "ab".repeat(65),
        nonce: TEST_NONCE,
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const cookieHeader = res.headers.getSetCookie();
    const sessionCookie = cookieHeader.find((c) =>
      c.startsWith("labeler_session=")
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/);
  });

  it("deletes the nonce record after successful verification", async () => {
    await prisma.walletNonce.create({
      data: {
        walletAddress: TEST_WALLET,
        nonce: TEST_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    vi.mocked(recoverMessageAddress).mockResolvedValue(TEST_WALLET);
    await POST(
      makeReq({
        address: TEST_WALLET,
        signature: "0x" + "ab".repeat(65),
        nonce: TEST_NONCE,
      })
    );
    const record = await prisma.walletNonce.findFirst({
      where: { walletAddress: TEST_WALLET, nonce: TEST_NONCE },
    });
    expect(record).toBeNull();
  });

  it("normalizes wallet address to lowercase", async () => {
    const upperAddr = "0xDEAD00000000000000000000000000000000BEEF";
    await prisma.walletNonce.create({
      data: {
        walletAddress: upperAddr.toLowerCase(),
        nonce: TEST_NONCE,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    vi.mocked(recoverMessageAddress).mockResolvedValue(
      TEST_WALLET
    );
    const res = await POST(
      makeReq({
        address: upperAddr,
        signature: "0x" + "ab".repeat(65),
        nonce: TEST_NONCE,
      })
    );
    expect(res.status).toBe(200);
  });
});
