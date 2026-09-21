import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

// Mock the session and Prisma; keep StrKey + SEP-53 verify real.
const {
  mockGetSession,
  mockNonceFindFirst,
  mockNonceDeleteMany,
  mockNonceCreate,
  mockUserUpdateMany,
  mockUserFindUnique,
  mockCheckWalletRateLimit,
  mockTakeOver,
} = vi.hoisted(() => ({
  mockTakeOver: vi.fn(),
  mockGetSession: vi.fn(),
  mockNonceFindFirst: vi.fn(),
  mockNonceDeleteMany: vi.fn(),
  mockNonceCreate: vi.fn(),
  mockUserUpdateMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockCheckWalletRateLimit: vi.fn(),
}));

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: mockGetSession };
});

vi.mock("@/lib/rate-limit", () => ({
  checkWalletRateLimit: mockCheckWalletRateLimit,
  WALLET_BURST_LIMIT: { max: 5, windowMs: 60_000 },
}));

vi.mock("@/lib/stellar/auth-challenge", () => ({ takeOverUnusedWalletAccount: mockTakeOver }));

vi.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    walletNonce: {
      findFirst: mockNonceFindFirst,
      deleteMany: mockNonceDeleteMany,
      create: mockNonceCreate,
    },
    user: { updateMany: mockUserUpdateMany, findUnique: mockUserFindUnique },
    $transaction: vi.fn(async (arr: Promise<unknown>[]) => Promise.all(arr)),
  },
}));

import { GET, POST, buildWalletLinkMessage } from "../route";
import { sep53Digest } from "@/lib/stellar/signature";
import { Prisma } from "@/app/generated/prisma/client";

const KP = Keypair.random();
const G = KP.publicKey();
const OTHER = Keypair.random().publicKey();
const USER_ID = "11111111-1111-1111-1111-111111111111";
const NONCE = "abc123nonce";

function sign(message: string): string {
  return KP.sign(sep53Digest(message)).toString("base64");
}

/** Build a wallet-link challenge request for an optional address. */
function getReq(address?: string): NextRequest {
  const url = new URL("http://localhost/api/me/wallet");
  if (address !== undefined) url.searchParams.set("address", address);
  return new NextRequest(url, { method: "GET" });
}

/** Build a wallet-link verification request with a JSON body. */
function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/me/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A valid proof for G over the current challenge. */
const provenPost = () => POST(postReq({ stellarAddress: G, signature: sign(buildWalletLinkMessage(G, NONCE)) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(USER_ID);
  mockNonceDeleteMany.mockResolvedValue({ count: 1 });
  mockNonceCreate.mockResolvedValue({});
  mockUserUpdateMany.mockResolvedValue({ count: 1 });
  mockUserFindUnique.mockResolvedValue({ walletAddress: G });
  mockNonceFindFirst.mockResolvedValue({ nonce: NONCE, walletAddress: G });
  mockCheckWalletRateLimit.mockResolvedValue(false);
  mockTakeOver.mockResolvedValue(false);
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
    // Scoped to the link flow, so a pending wallet sign-in challenge for the
    // same address survives.
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({
      where: {
        walletAddress: G,
        action: "link-payout-address",
        expiresAt: { lte: expect.any(Date) },
      },
    });
    expect(mockNonceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ walletAddress: G, action: "link-payout-address" }),
      }),
    );
  });

  it("reuses the committed link challenge when a concurrent create loses P2002", async () => {
    mockNonceCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mockNonceFindFirst.mockResolvedValueOnce({ nonce: NONCE, walletAddress: G });

    const res = await GET(getReq(G));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: buildWalletLinkMessage(G, NONCE), nonce: NONCE });
  });

  it("retries issuance when the challenge that caused P2002 has already expired", async () => {
    mockNonceCreate
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      )
      .mockResolvedValueOnce({});
    mockNonceFindFirst.mockResolvedValueOnce(null);

    const res = await GET(getReq(G));

    expect(res.status).toBe(200);
    expect(mockNonceCreate).toHaveBeenCalledTimes(2);
  });

  it("429s and issues no nonce when the per-address rate limit trips", async () => {
    mockCheckWalletRateLimit.mockResolvedValueOnce(true);
    const res = await GET(getReq(G));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(mockCheckWalletRateLimit).toHaveBeenCalledWith(`link:${G}`, { max: 5, windowMs: 60_000 });
    expect(mockNonceCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/me/wallet (prove + bind)", () => {
  it("401 without a session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await provenPost();
    expect(res.status).toBe(401);
  });

  it("400 for an invalid address", async () => {
    const res = await POST(postReq({ stellarAddress: "not-a-key", signature: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_address");
  });

  it("400 challenge_expired when no live nonce exists", async () => {
    mockNonceFindFirst.mockResolvedValueOnce(null);
    const res = await provenPost();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("challenge_expired");
  });

  it("401 when the signature does not verify", async () => {
    const wrong = Keypair.random();
    const badSig = wrong.sign(sep53Digest(buildWalletLinkMessage(G, NONCE))).toString("base64");
    const res = await POST(postReq({ stellarAddress: G, signature: badSig }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_signature");
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it("400 challenge_expired when the verified nonce is no longer live at consumption", async () => {
    mockNonceDeleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await provenPost();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("challenge_expired");
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({
      where: {
        nonce: NONCE,
        walletAddress: G,
        action: "link-payout-address",
        expiresAt: { gt: expect.any(Date) },
      },
    });
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  it("binds the proven address to an account with no usable wallet, consuming the nonce", async () => {
    const res = await provenPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, walletAddress: G });
    expect(mockNonceDeleteMany).toHaveBeenCalledWith({
      where: {
        nonce: NONCE,
        walletAddress: G,
        action: "link-payout-address",
        expiresAt: { gt: expect.any(Date) },
      },
    });
    // A sign-in challenge row can never be used to link an address.
    expect(mockNonceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ walletAddress: G, action: "link-payout-address" }),
      }),
    );
    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, OR: [{ walletAddress: null }, { walletAddress: { startsWith: "0x" } }] },
      data: { walletAddress: G },
    });
  });

  it("binds before any trustline exists — payout setup sponsors the bound wallet afterwards (#30)", async () => {
    // No Horizon read is mocked: the route no longer makes one.
    const res = await provenPost();
    expect(res.status).toBe(200);
    expect(mockUserUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("succeeds without a write when the account already holds this wallet", async () => {
    mockUserUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockUserFindUnique.mockResolvedValueOnce({ walletAddress: G });
    const res = await provenPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, walletAddress: G });
  });

  it("409 wallet_already_bound when the account holds a different Stellar wallet (#30)", async () => {
    mockUserUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockUserFindUnique.mockResolvedValueOnce({ walletAddress: OTHER });
    const res = await provenPost();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet_already_bound" });
  });

  it("401 when the session's account no longer exists", async () => {
    mockUserUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockUserFindUnique.mockResolvedValueOnce(null);
    const res = await provenPost();
    expect(res.status).toBe(401);
  });

  it("409 address_already_linked when the address is claimed by another account (P2002)", async () => {
    mockUserUpdateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const res = await provenPost();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("address_already_linked");
    // The nonce was consumed before the collision.
    expect(mockNonceDeleteMany).toHaveBeenCalled();
    expect(mockTakeOver).toHaveBeenCalledWith(G, USER_ID);
  });

  it("binds after taking over the empty wallet-only account an accidental wallet sign-in created (PR #105 review)", async () => {
    mockUserUpdateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mockTakeOver.mockResolvedValueOnce(true);

    const res = await provenPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true, walletAddress: G });
    expect(mockTakeOver).toHaveBeenCalledWith(G, USER_ID);
  });

  it("never tries a takeover before the proof verifies", async () => {
    const wrong = Keypair.random();
    const badSig = wrong.sign(sep53Digest(buildWalletLinkMessage(G, NONCE))).toString("base64");
    await POST(postReq({ stellarAddress: G, signature: badSig }));
    expect(mockTakeOver).not.toHaveBeenCalled();
  });
});
