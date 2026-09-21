import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

// PR #105 review: the client flow's unit tests mock `fetch`, so none of them met
// the real limiter. Here the payout-setup flow drives the sponsor route's
// handlers directly, through the real rate limiter on the test database. Only
// the session, Horizon and the sponsorship ledger are faked; the route and the
// limiter are what is under test.

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  hasTrustline: vi.fn(),
  build: vi.fn(),
  prepare: vi.fn(),
  broadcast: vi.fn(),
  txStatus: vi.fn(),
  openIntent: vi.fn(),
}));

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerUser: m.getUser };
});
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    accountHasUsdcTrustline: m.hasTrustline,
    buildSponsoredTrustlineTx: m.build,
    prepareSponsoredTrustline: m.prepare,
    getTxStatus: m.txStatus,
  };
});
vi.mock("@/lib/sponsored-trustline", () => ({
  checkSponsorAllowed: async () => ({ ok: true }),
  livePendingSponsorship: async () => false,
  openSponsorshipIntent: m.openIntent,
  confirmSponsorship: async () => {},
  failSponsorship: async () => {},
  hasConfirmedSponsorship: async () => false,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { GET, POST } from "../route";
import { StellarPaymentError } from "@/lib/stellar/client";
import { setUpPayouts } from "@/lib/stellar/payout-setup";
import { WALLET_BURST_LIMIT } from "@/lib/rate-limit";

/** A `fetch` that answers from the sponsor route's handlers, as the browser would reach them. */
const viaRoute = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new NextRequest(new URL(String(input), "http://localhost"), {
    method: init?.method,
    headers: init?.headers as HeadersInit | undefined,
    body: init?.body as BodyInit | undefined,
  });
  return init?.method === "POST" ? POST(req) : GET(req);
}) as unknown as typeof fetch;

let address: string;
let envelope = 0;

beforeEach(() => {
  vi.clearAllMocks();
  // Fresh keys per case: the limiter's buckets outlive a test.
  address = Keypair.random().publicKey();
  m.getUser.mockResolvedValue({ id: randomUUID(), walletAddress: address });
  m.hasTrustline.mockResolvedValue(false);
  m.build.mockImplementation(async () => ({ xdr: `XDR-${++envelope}`, kind: "trustline" }));
  m.prepare.mockImplementation((signedXdr: string) => ({
    hash: `H-${signedXdr}`,
    kind: "trustline",
    expiresAt: new Date(Date.now() + 180_000),
    submit: m.broadcast,
  }));
  m.openIntent.mockResolvedValue({ action: "submit", id: "row-1" });
  m.txStatus.mockResolvedValue("not_found");
});

describe("payout setup through the real limiter", () => {
  it("rebuilds after retry without being throttled", async () => {
    m.broadcast
      .mockRejectedValueOnce(new StellarPaymentError("stale", "tx_bad_seq", true))
      .mockResolvedValueOnce({ hash: "H", feeBumpHash: "FB" });
    let signed = 0;
    const sleep = vi.fn(async () => {});

    const result = await setUpPayouts({
      signTransaction: async () => `SIGNED-${++signed}`,
      fetch: viaRoute,
      sleep,
    });

    expect(result).toEqual({ ok: true, address, sponsored: true });
    expect(signed).toBe(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("passes a reload straight after setup, and another after that", async () => {
    m.hasTrustline.mockResolvedValue(true);
    const deps = { signTransaction: vi.fn(), fetch: viaRoute, sleep: vi.fn(async () => {}) };

    for (let load = 0; load < 3; load++) {
      await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address, sponsored: false });
    }
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("past the burst, answers 429 with a Retry-After the client can wait out", async () => {
    m.hasTrustline.mockResolvedValue(true);
    for (let i = 0; i < WALLET_BURST_LIMIT.max; i++) {
      expect((await viaRoute("/api/me/wallet/sponsor")).status).toBe(200);
    }

    const refused = await viaRoute("/api/me/wallet/sponsor");

    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(WALLET_BURST_LIMIT.windowMs / 1000);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
  });
});
