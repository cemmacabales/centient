import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

// Mock the session + the Horizon trustline read; keep StrKey + SEP-53 verify real.
const {
  mockGetSession,
  mockNonceFindFirst,
  mockNonceDeleteMany,
  mockNonceCreate,
  mockUserUpdate,
  mockHasTrustline,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockNonceFindFirst: vi.fn(),
  mockNonceDeleteMany: vi.fn(),
  mockNonceCreate: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockHasTrustline: vi.fn(),
}));

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: mockGetSession };
});

vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return { ...actual, accountHasUsdcTrustline: mockHasTrustline };
});

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    walletNonce: {
      findFirst: mockNonceFindFirst,
      deleteMany: mockNonceDeleteMany,
      create: mockNonceCreate,
    },
    user: { update: mockUserUpdate },
    $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
  },
}));

import { GET, POST, buildWalletLinkMessage } from "../route";
import { sep53Digest } from "@/lib/stellar/signature";

const KP = Keypair.random();
const G = KP.publicKey();
const USER_ID = "11111111-1111-1111-1111-111111111111";
const NONCE = "abc123nonce";

function sign(message: string): string {
  return KP.sign(sep53Digest(message)).toString("base64");
}

function getReq(address?: string): NextRequest {
  const url = new URL("http://localhost/api/me/wallet");
  if (address !== undefined) url.searchParams.set("address", address);
  return new NextRequest(url, { method: "GET" });
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/me/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(USER_ID);
  mockNonceDeleteMany.mockResolvedValue({ count: 0 });
  mockNonceCreate.mockResolvedValue({});
  mockUserUpdate.mockResolvedValue({});
  mockHasTrustline.mockResolvedValue(true);
  mockNonceFindFirst.mockResolvedValue({ nonce: NONCE, walletAddress: G });
});

describe("GET /api/me/wallet (challenge)", () => {
  it("401 without a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await GET(getReq(G));
    expect(res.status).toBe(401);
  });

  it("400 for an invalid (non-StrKey) address", async () => {
    const res = await GET(getReq("0xdeadbeef"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_address");
  });

  it("issues a signable challenge bound to the address + a fresh nonce", async () => {
    const res = await GET(getReq(G));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain(G);
    expect(body.message).toContain(body.nonce);
    expect(mockNonceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ walletAddress: G }) }),
    );
  });
});

describe("POST /api/me/wallet (link + prove)", () => {
  it("401 without a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(postReq({ stellarAddress: G, signature: sign(buildWalletLinkMessage(G, NONCE)) }));
    expect(res.status).toBe(401);
  });

  it("400 for an invalid address", async () => {
    const res = await POST(postReq({ stellarAddress: "not-a-key", signature: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_address");
  });

  it("400 challenge_expired when no live nonce exists", async () => {
    mockNonceFindFirst.mockResolvedValueOnce(null);
    const res = await POST(postReq({ stellarAddress: G, signature: sign(buildWalletLinkMessage(G, NONCE)) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("challenge_expired");
  });

  it("401 when the signature does not verify", async () => {
    const wrong = Keypair.random();
    const badSig = wrong.sign(sep53Digest(buildWalletLinkMessage(G, NONCE))).toString("base64");
    const res = await POST(postReq({ stellarAddress: G, signature: badSig }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_signature");
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("409 no_trustline when the proven address holds no USDC trustline", async () => {
    mockHasTrustline.mockResolvedValueOnce(false);
    const res = await POST(postReq({ stellarAddress: G, signature: sign(buildWalletLinkMessage(G, NONCE)) }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_trustline");
    // Challenge is consumed even on a trustline reject (one-time use).
    expect(mockNonceDeleteMany).toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("links the address on a valid proof + trustline, consuming the nonce", async () => {
    const res = await POST(postReq({ stellarAddress: G, signature: sign(buildWalletLinkMessage(G, NONCE)) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, walletAddress: G });
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({ where: { walletAddress: G } });
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: { walletAddress: G },
      }),
    );
  });
});
