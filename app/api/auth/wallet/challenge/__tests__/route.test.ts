import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, Networks } from "@stellar/stellar-sdk";

vi.mock("@/lib/rate-limit", () => ({
  checkWalletRateLimit: vi.fn(async () => false),
  WALLET_BURST_LIMIT: { max: 5, windowMs: 60_000 },
}));

const { mockHasTrustline, mockBuildOffer, mockLivePending, mockCapture } = vi.hoisted(() => ({
  mockHasTrustline: vi.fn(),
  mockBuildOffer: vi.fn(),
  mockLivePending: vi.fn(),
  mockCapture: vi.fn(),
}));
// #170: Horizon and the sponsor stay out of these tests; the offer's own
// guarantees are tested in lib/stellar/__tests__/sponsorship-offer.test.ts.
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return { ...actual, accountHasUsdcTrustline: mockHasTrustline, buildSponsorshipOffer: mockBuildOffer };
});
vi.mock("@/lib/sponsored-trustline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sponsored-trustline")>();
  return { ...actual, livePendingSponsorship: mockLivePending };
});
vi.mock("@sentry/nextjs", () => ({ captureException: mockCapture }));

import { CHALLENGE_IP_LIMIT, PAYOUT_SETUP_OFFER_DEADLINE_MS, POST } from "@/app/api/auth/wallet/challenge/route";
import { WALLET_BURST_LIMIT, checkWalletRateLimit } from "@/lib/rate-limit";
import { PROOF_ACTION, buildChallengeMessage } from "@/lib/stellar/challenge-message";
import { prisma, truncateAll } from "@/tests/helpers/db";

const IP = "203.0.113.7";
const OFFER = {
  xdr: "UNSIGNED-XDR",
  kind: "account+trustline" as const,
  offer: "TAG",
  expiresAt: new Date("2026-09-30T12:03:00.000Z"),
};
const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;

/** Build a challenge-route request, with the trusted-proxy test address unless `ip` is null. */
function makeReq(body: unknown, ip: string | null = IP): NextRequest {
  return new NextRequest("http://localhost/api/auth/wallet/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  await truncateAll();
  vi.mocked(checkWalletRateLimit).mockReset().mockResolvedValue(false);
  mockHasTrustline.mockReset().mockResolvedValue(false);
  mockLivePending.mockReset().mockResolvedValue(false);
  mockBuildOffer.mockReset().mockResolvedValue(OFFER);
  mockCapture.mockReset();
});

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
});

describe("POST /api/auth/wallet/challenge", () => {
  it("issues a challenge without any session", async () => {
    const address = Keypair.random().publicKey();

    const res = await POST(makeReq({ address }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);

    const row = await prisma.walletNonce.findUniqueOrThrow({ where: { nonce: body.nonce } });
    expect(row.action).toBe(PROOF_ACTION);
    expect(body.expiresAt).toBe(row.expiresAt.toISOString());
    expect(body.message).toBe(
      buildChallengeMessage({
        address,
        networkPassphrase: Networks.TESTNET,
        nonce: body.nonce,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
      }),
    );
  });

  it.each([
    ["a lowercased address", () => ({ address: Keypair.random().publicKey().toLowerCase() })],
    ["a non-StrKey address", () => ({ address: "0xdeadbeef" })],
    ["a missing address", () => ({})],
    ["a non-string address", () => ({ address: 42 })],
    ["a non-JSON body", () => "not json"],
  ])("400 invalid_address for %s, issuing nothing", async (_name, body) => {
    const res = await POST(makeReq(body()));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_address" });
    expect(await prisma.walletNonce.count()).toBe(0);
    expect(checkWalletRateLimit).not.toHaveBeenCalled();
  });

  it("429 when the caller's IP is throttled, issuing nothing", async () => {
    vi.mocked(checkWalletRateLimit).mockResolvedValueOnce(true);

    const res = await POST(makeReq({ address: Keypair.random().publicKey() }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(checkWalletRateLimit).toHaveBeenCalledWith(`auth-challenge-ip:${IP}`, CHALLENGE_IP_LIMIT);
    expect(await prisma.walletNonce.count()).toBe(0);
  });

  it("429 when the address is throttled, issuing nothing", async () => {
    const address = Keypair.random().publicKey();
    vi.mocked(checkWalletRateLimit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const res = await POST(makeReq({ address }));

    expect(res.status).toBe(429);
    expect(checkWalletRateLimit).toHaveBeenCalledWith(`auth-challenge:${address}`, WALLET_BURST_LIMIT);
    expect(await prisma.walletNonce.count()).toBe(0);
  });

  it("allows a burst per address and per IP, so an immediate retry after a declined prompt works", () => {
    expect(WALLET_BURST_LIMIT.max).toBeGreaterThan(1);
    expect(CHALLENGE_IP_LIMIT.max).toBeGreaterThan(WALLET_BURST_LIMIT.max);
  });

  it("skips the per-IP throttle without a proxy-supplied IP, rather than pooling every caller", async () => {
    const address = Keypair.random().publicKey();

    const res = await POST(makeReq({ address }, null));

    expect(res.status).toBe(200);
    expect(vi.mocked(checkWalletRateLimit).mock.calls.map(([key]) => key)).toEqual([`auth-challenge:${address}`]);
  });
});

describe("POST /api/auth/wallet/challenge — payout setup's envelope (#170)", () => {
  it("offers nothing, and asks Horizon nothing, unless the client asks", async () => {
    const res = await POST(makeReq({ address: Keypair.random().publicKey() }));

    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("sponsorship");
    expect(mockHasTrustline).not.toHaveBeenCalled();
    expect(mockBuildOffer).not.toHaveBeenCalled();
  });

  it("offers the envelope alongside the challenge for a wallet that needs one", async () => {
    const address = Keypair.random().publicKey();

    const res = await POST(makeReq({ address, payoutSetup: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.sponsorship).toEqual({
      xdr: "UNSIGNED-XDR",
      kind: "account+trustline",
      offer: "TAG",
      expiresAt: "2026-09-30T12:03:00.000Z",
    });
    expect(mockBuildOffer).toHaveBeenCalledWith(address);
  });

  it("offers nothing to a wallet that already trusts USDC", async () => {
    mockHasTrustline.mockResolvedValue(true);

    const res = await POST(makeReq({ address: Keypair.random().publicKey(), payoutSetup: true }));

    expect(await res.json()).not.toHaveProperty("sponsorship");
    expect(mockBuildOffer).not.toHaveBeenCalled();
  });

  it("offers nothing while a sponsorship of the address is still pending", async () => {
    mockLivePending.mockResolvedValue(true);

    const res = await POST(makeReq({ address: Keypair.random().publicKey(), payoutSetup: true }));

    expect(await res.json()).not.toHaveProperty("sponsorship");
    expect(mockBuildOffer).not.toHaveBeenCalled();
  });

  it.each([
    ["Horizon can't be read", () => mockHasTrustline.mockRejectedValue(new Error("horizon down"))],
    ["the envelope can't be built", () => mockBuildOffer.mockRejectedValue(new Error("sponsor_low_reserve"))],
  ])("still issues the challenge when %s, without an offer", async (_name, arrange) => {
    arrange();

    const res = await POST(makeReq({ address: Keypair.random().publicKey(), payoutSetup: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body).not.toHaveProperty("sponsorship");
    expect(mockCapture).toHaveBeenCalled();
  });

  it("issues the challenge alone once the offer outlasts its deadline, rather than hanging on Horizon", async () => {
    // Real time still passes for the database; only the deadline is jumped.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockHasTrustline.mockReturnValue(new Promise<never>(() => {}));

      const pending = POST(makeReq({ address: Keypair.random().publicKey(), payoutSetup: true }));
      await vi.waitFor(() => expect(mockHasTrustline).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(PAYOUT_SETUP_OFFER_DEADLINE_MS);
      const res = await pending;

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(body).not.toHaveProperty("sponsorship");
      expect(mockCapture).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds nothing for a throttled caller", async () => {
    vi.mocked(checkWalletRateLimit).mockResolvedValueOnce(true);

    const res = await POST(makeReq({ address: Keypair.random().publicKey(), payoutSetup: true }));

    expect(res.status).toBe(429);
    expect(mockHasTrustline).not.toHaveBeenCalled();
    expect(mockBuildOffer).not.toHaveBeenCalled();
  });

  it("takes only a literal true, so a stray field can't trigger Horizon lookups", async () => {
    const res = await POST(makeReq({ address: Keypair.random().publicKey(), payoutSetup: "yes" }));

    expect(await res.json()).not.toHaveProperty("sponsorship");
    expect(mockHasTrustline).not.toHaveBeenCalled();
  });
});
