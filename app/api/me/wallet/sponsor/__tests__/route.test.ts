import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

const {
  mockGetUser, mockHasTrustline, mockBuild, mockPrepare, mockBroadcast, mockTxStatus,
  mockRateLimit, mockCheckAllowed, mockLivePending, mockOpenIntent, mockConfirm, mockFail,
  mockCapture, mockChain, mockHasConfirmed,
} = vi.hoisted(() => ({
  mockChain: vi.fn(),
  mockHasConfirmed: vi.fn(),
  mockGetUser: vi.fn(),
  mockHasTrustline: vi.fn(),
  mockBuild: vi.fn(),
  mockPrepare: vi.fn(),
  mockBroadcast: vi.fn(),
  mockTxStatus: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCheckAllowed: vi.fn(),
  mockLivePending: vi.fn(),
  mockOpenIntent: vi.fn(),
  mockConfirm: vi.fn(),
  mockFail: vi.fn(),
  mockCapture: vi.fn(),
}));

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerUser: mockGetUser };
});
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    accountHasUsdcTrustline: mockHasTrustline,
    buildSponsoredTrustlineTx: mockBuild,
    prepareSponsoredTrustline: mockPrepare,
    getTxStatus: mockTxStatus,
  };
});
vi.mock("@/lib/rate-limit", () => ({
  takeRateLimit: mockRateLimit,
  WALLET_BURST_LIMIT: { max: 5, windowMs: 60_000 },
}));
vi.mock("@/lib/sponsored-trustline", () => ({
  checkSponsorAllowed: mockCheckAllowed,
  livePendingSponsorship: mockLivePending,
  openSponsorshipIntent: mockOpenIntent,
  confirmSponsorship: mockConfirm,
  failSponsorship: mockFail,
  hasConfirmedSponsorship: mockHasConfirmed,
}));
vi.mock("@/lib/stellar/sponsorship-reclaim", () => ({ readSponsorshipOnChain: mockChain }));
vi.mock("@sentry/nextjs", () => ({ captureException: mockCapture }));

import { GET, POST } from "../route";
import { StellarPaymentError } from "@/lib/stellar/client";

const ADDR = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const EXPIRES = new Date("2026-09-15T01:03:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ id: "user-1", walletAddress: ADDR });
  mockRateLimit.mockResolvedValue({ limited: false });
  mockCheckAllowed.mockResolvedValue({ ok: true });
  mockLivePending.mockResolvedValue(false);
  mockHasConfirmed.mockResolvedValue(false);
  mockPrepare.mockReturnValue({
    hash: "H",
    kind: "account+trustline",
    expiresAt: EXPIRES,
    submit: mockBroadcast,
  });
  mockOpenIntent.mockResolvedValue({ action: "submit", id: "row-1" });
  mockBroadcast.mockResolvedValue({ hash: "H" });
  mockConfirm.mockResolvedValue(undefined);
  mockFail.mockResolvedValue(undefined);
});

/** A GET build request, naming `address` when one is given. */
function getReq(address?: string) {
  const url = new URL("http://localhost/api/me/wallet/sponsor");
  if (address !== undefined) url.searchParams.set("address", address);
  return new NextRequest(url);
}
/** A POST submit request carrying `body` as JSON. */
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/me/wallet/sponsor", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
/** Submit a signed envelope for the session's wallet. */
const post = () => POST(postReq({ signedXdr: "SIGNED" }));

describe("GET /api/me/wallet/sponsor", () => {
  it("401 without a session", async () => {
    mockGetUser.mockResolvedValue(null);
    expect((await GET(getReq())).status).toBe(401);
  });
  it.each([
    ["no wallet", null],
    ["a legacy 0x wallet", "0x00000000000000000000000000000000000000aa"],
  ])("409 wallet_required when the account has %s, without reading Horizon (#30)", async (_label, walletAddress) => {
    mockGetUser.mockResolvedValue({ id: "user-1", walletAddress });
    const res = await GET(getReq());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet_required" });
    expect(mockHasTrustline).not.toHaveBeenCalled();
  });
  it("403 address_not_bound when the named address is not the session's wallet (#30)", async () => {
    const res = await GET(getReq(OTHER));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "address_not_bound" });
    expect(mockHasTrustline).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("accepts a request naming the session's own wallet", async () => {
    mockHasTrustline.mockResolvedValue(true);
    const res = await GET(getReq(ADDR));
    expect(res.status).toBe(200);
    expect(mockHasTrustline).toHaveBeenCalledWith(ADDR);
  });
  it("returns needed:false with the bound address when a trustline already exists", async () => {
    mockHasTrustline.mockResolvedValue(true);
    const body = await (await GET(getReq())).json();
    expect(body).toEqual({ needed: false, address: ADDR });
    expect(mockHasTrustline).toHaveBeenCalledWith(ADDR);
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("returns the sponsored xdr + kind for the bound address when no trustline", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockBuild.mockResolvedValue({ xdr: "XDR", kind: "trustline" });
    const body = await (await GET(getReq())).json();
    expect(body).toEqual({ needed: true, address: ADDR, xdr: "XDR", kind: "trustline" });
    expect(mockBuild).toHaveBeenCalledWith(ADDR);
  });
  it("429 sponsorship_cap_reached when the user is at the outstanding cap (#330)", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockCheckAllowed.mockResolvedValue({ ok: false, reason: "cap_reached" });
    const res = await GET(getReq());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("sponsorship_cap_reached");
    expect(mockBuild).not.toHaveBeenCalled(); // never hand out an unusable XDR
  });
  it("409 address_in_use when the address is sponsored by another user (#330)", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockCheckAllowed.mockResolvedValue({ ok: false, reason: "address_sponsored_by_other" });
    const res = await GET(getReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("address_in_use");
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("409 submission_pending while an earlier envelope for the address could still land (#27)", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockLivePending.mockResolvedValue(true);
    const res = await GET(getReq());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("submission_pending");
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("503 sponsorship_unavailable when the sponsor cannot cover the reserve, before any XDR is offered (#27)", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockBuild.mockRejectedValue(new StellarPaymentError("low", "sponsor_low_reserve", false));
    const res = await GET(getReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sponsorship_unavailable" });
  });
  it("does not consume the cap when the address already trusts USDC (#330)", async () => {
    mockHasTrustline.mockResolvedValue(true);
    await GET(getReq());
    expect(mockCheckAllowed).not.toHaveBeenCalled();
  });
  it("429 with a Retry-After when rate-limited by address", async () => {
    mockRateLimit.mockImplementation(async (key: string) =>
      key.startsWith("sponsor-build:") ? { limited: true, retryAfterSeconds: 42 } : { limited: false },
    );
    const res = await GET(getReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect((await res.json()).error).toBe("rate_limited");
    expect(mockRateLimit).toHaveBeenCalledWith(`sponsor-build:${ADDR}`, { max: 5, windowMs: 60_000 });
  });
  // Ensure distinct keys per phase so GET doesn't consume POST's bucket.
  it("429 when per-user rate limit fires on GET (sponsor-get: key), without spending the address's", async () => {
    mockRateLimit.mockImplementation(async (key: string) =>
      key.startsWith("sponsor-get:") ? { limited: true, retryAfterSeconds: 9 } : { limited: false },
    );
    const res = await GET(getReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect((await res.json()).error).toBe("rate_limited");
    expect(mockRateLimit).toHaveBeenCalledTimes(1);
  });
  it("answers needed:false from a confirmed sponsorship when Horizon cannot be reached (PR #105 review)", async () => {
    mockHasTrustline.mockRejectedValue(new Error("horizon down"));
    mockHasConfirmed.mockResolvedValue(true);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needed: false, address: ADDR });
    expect(mockHasConfirmed).toHaveBeenCalledWith("user-1", ADDR);
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("502 build_failed when Horizon cannot be reached and no confirmed sponsorship stands in", async () => {
    mockHasTrustline.mockRejectedValue(new Error("horizon down"));
    const res = await GET(getReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("build_failed");
  });
  it("502 when build throws", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockBuild.mockRejectedValue(new Error("horizon down"));
    const res = await GET(getReq());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("build_failed");
  });
});

describe("POST /api/me/wallet/sponsor", () => {
  it("401 without a session", async () => {
    mockGetUser.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
  });
  it("409 wallet_required when the account has no bound wallet, without preparing (#30)", async () => {
    mockGetUser.mockResolvedValue({ id: "user-1", walletAddress: null });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet_required" });
    expect(mockPrepare).not.toHaveBeenCalled();
  });
  it("403 address_not_bound when the body names another address, without preparing (#30)", async () => {
    const res = await POST(postReq({ address: OTHER, signedXdr: "SIGNED" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "address_not_bound" });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockOpenIntent).not.toHaveBeenCalled();
  });
  it("400 invalid_body when the address is not a string", async () => {
    expect((await POST(postReq({ address: 7, signedXdr: "SIGNED" }))).status).toBe(400);
  });
  it("400 invalid_body without a signed envelope", async () => {
    expect((await POST(postReq({}))).status).toBe(400);
  });

  it("records the intent for the bound address before broadcasting, then confirms it (#27)", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ established: true });
    expect(mockPrepare).toHaveBeenCalledWith("SIGNED", ADDR);
    expect(mockOpenIntent).toHaveBeenCalledWith(
      { userId: "user-1", address: ADDR, kind: "account+trustline", txHash: "H", expiresAt: EXPIRES },
      // The chain lookup lets the ledger re-check a `confirmed` row (PR #105 review).
      { txStatus: mockTxStatus, chain: mockChain },
    );
    expect(mockOpenIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mockBroadcast.mock.invocationCallOrder[0],
    );
    expect(mockConfirm).toHaveBeenCalledWith("row-1", "H");
  });

  it("accepts a body naming the session's own wallet", async () => {
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(200);
    expect(mockPrepare).toHaveBeenCalledWith("SIGNED", ADDR);
  });

  it("still answers established if confirming the row fails — it stays pending and counted", async () => {
    mockConfirm.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ established: true });
    expect(mockCapture).toHaveBeenCalled();
  });

  it("502 without broadcasting when the intent cannot be written (#27)", async () => {
    mockOpenIntent.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("submit_failed");
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("400 invalid_sponsor_tx without writing an intent", async () => {
    mockPrepare.mockImplementation(() => {
      throw new StellarPaymentError("x", "invalid_sponsor_tx", false);
    });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_sponsor_tx");
    expect(mockOpenIntent).not.toHaveBeenCalled();
  });

  it("409 address_in_use when the database refuses the address, without broadcasting", async () => {
    mockOpenIntent.mockResolvedValue({ action: "address_in_use" });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("address_in_use");
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("200 established without broadcasting when an earlier envelope already landed", async () => {
    mockOpenIntent.mockResolvedValue({ action: "already_confirmed" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ established: true });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("409 submission_pending without broadcasting while an earlier envelope could still land", async () => {
    mockOpenIntent.mockResolvedValue({ action: "prior_pending" });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("submission_pending");
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("429 sponsorship_cap_reached at the outstanding cap, without submitting (#330)", async () => {
    mockCheckAllowed.mockResolvedValue({ ok: false, reason: "cap_reached" });
    const res = await post();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("sponsorship_cap_reached");
    expect(mockOpenIntent).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
  it("409 address_in_use when sponsored by another user, without submitting (#330)", async () => {
    mockCheckAllowed.mockResolvedValue({ ok: false, reason: "address_sponsored_by_other" });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("address_in_use");
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("503 sponsorship_unavailable on op_low_reserve, and releases the intent", async () => {
    mockBroadcast.mockRejectedValue(new StellarPaymentError("x", "op_low_reserve", false));
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("sponsorship_unavailable");
    expect(mockFail).toHaveBeenCalledWith("row-1", "H");
  });

  it("503 sponsorship_unavailable when the sponsor cannot pay the fee bump, and releases the intent (#28)", async () => {
    mockBroadcast.mockRejectedValue(new StellarPaymentError("x", "sponsor_low_reserve", false));
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("sponsorship_unavailable");
    expect(mockFail).toHaveBeenCalledWith("row-1", "H");
    expect(mockTxStatus).not.toHaveBeenCalled();
  });

  it("409 retry on tx_bad_seq when the envelope never landed, and releases the intent", async () => {
    mockBroadcast.mockRejectedValue(new StellarPaymentError("x", "tx_bad_seq", true));
    mockTxStatus.mockResolvedValue("not_found");
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("retry");
    expect(mockTxStatus).toHaveBeenCalledWith("H");
    expect(mockFail).toHaveBeenCalledWith("row-1", "H");
  });

  it("treats tx_bad_seq for an envelope that already landed as established", async () => {
    mockBroadcast.mockRejectedValue(new StellarPaymentError("x", "tx_bad_seq", true));
    mockTxStatus.mockResolvedValue("confirmed");
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockConfirm).toHaveBeenCalledWith("row-1", "H");
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("502 submit_failed on a definite rejection, and releases the intent", async () => {
    mockBroadcast.mockRejectedValue(new StellarPaymentError("x", "sponsor_tx_rejected", false));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("submit_failed");
    expect(mockFail).toHaveBeenCalledWith("row-1", "H");
  });

  describe("an ambiguous submit (Horizon timeout)", () => {
    /** The error the client raises when a submit's outcome is unknown. */
    const unknown = () => new StellarPaymentError("timeout", "submission_unknown", false);

    it("answers established when the hash turns out to have landed", async () => {
      mockBroadcast.mockRejectedValue(unknown());
      mockTxStatus.mockResolvedValue("confirmed");
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ established: true });
      expect(mockConfirm).toHaveBeenCalledWith("row-1", "H");
    });

    it("answers 202 pending and keeps the intent when the hash is not visible yet — never 'rebuild'", async () => {
      mockBroadcast.mockRejectedValue(unknown());
      mockTxStatus.mockResolvedValue("not_found");
      const res = await post();
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ established: false, pending: true });
      expect(mockFail).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("answers 202 pending when the status lookup itself fails", async () => {
      mockBroadcast.mockRejectedValue(unknown());
      mockTxStatus.mockRejectedValue(new Error("horizon down"));
      const res = await post();
      expect(res.status).toBe(202);
      expect(mockFail).not.toHaveBeenCalled();
    });

    it("502 and releases the intent when Horizon reports the hash failed", async () => {
      mockBroadcast.mockRejectedValue(unknown());
      mockTxStatus.mockResolvedValue("failed");
      const res = await post();
      expect(res.status).toBe(502);
      expect(mockFail).toHaveBeenCalledWith("row-1", "H");
    });

    it("treats an unclassified error the same way — it may have been broadcast", async () => {
      mockBroadcast.mockRejectedValue(new Error("socket hang up"));
      mockTxStatus.mockResolvedValue("not_found");
      const res = await post();
      expect(res.status).toBe(202);
      expect(mockFail).not.toHaveBeenCalled();
    });
  });

  // Distinct per-phase key so POST doesn't share GET's bucket.
  it("429 when per-user rate limit fires on POST (sponsor-submit: key)", async () => {
    mockRateLimit.mockImplementation(async (key: string) =>
      key.startsWith("sponsor-submit:") ? { limited: true, retryAfterSeconds: 5 } : { limited: false },
    );
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect((await res.json()).error).toBe("rate_limited");
    expect(mockOpenIntent).not.toHaveBeenCalled();
  });
});
