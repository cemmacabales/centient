import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

const {
  mockGetSession, mockHasTrustline, mockBuild, mockSubmit, mockRateLimit,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockHasTrustline: vi.fn(),
  mockBuild: vi.fn(),
  mockSubmit: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: mockGetSession };
});
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    accountHasUsdcTrustline: mockHasTrustline,
    buildSponsoredTrustlineTx: mockBuild,
    submitSponsoredTrustline: mockSubmit,
  };
});
vi.mock("@/lib/rate-limit", () => ({ checkWalletRateLimit: mockRateLimit }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { GET, POST } from "../route";
import { StellarPaymentError } from "@/lib/stellar/client";

const ADDR = Keypair.random().publicKey();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue("user-1");
  mockRateLimit.mockResolvedValue(false);
});

function getReq(address: string) {
  return new NextRequest(`http://localhost/api/me/wallet/sponsor?address=${encodeURIComponent(address)}`);
}
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/me/wallet/sponsor", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("GET /api/me/wallet/sponsor", () => {
  it("401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await GET(getReq(ADDR))).status).toBe(401);
  });
  it("400 on an invalid address", async () => {
    expect((await GET(getReq("not-a-key"))).status).toBe(400);
  });
  it("returns needed:false when a trustline already exists", async () => {
    mockHasTrustline.mockResolvedValue(true);
    const body = await (await GET(getReq(ADDR))).json();
    expect(body).toEqual({ needed: false });
    expect(mockBuild).not.toHaveBeenCalled();
  });
  it("returns the sponsored xdr + kind when no trustline", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockBuild.mockResolvedValue({ xdr: "XDR", kind: "trustline" });
    const body = await (await GET(getReq(ADDR))).json();
    expect(body).toEqual({ needed: true, xdr: "XDR", kind: "trustline" });
  });
  it("429 when rate-limited by address", async () => {
    mockRateLimit.mockResolvedValue(true);
    const res = await GET(getReq(ADDR));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });
  // Ensure distinct keys per phase so GET doesn't consume POST's bucket.
  it("429 when per-user rate limit fires on GET (sponsor-get: key)", async () => {
    mockRateLimit.mockImplementation(async (key: string) => key.startsWith("sponsor-get:"));
    const res = await GET(getReq(ADDR));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });
  it("502 when build throws", async () => {
    mockHasTrustline.mockResolvedValue(false);
    mockBuild.mockRejectedValue(new Error("horizon down"));
    const res = await GET(getReq(ADDR));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("build_failed");
  });
});

describe("POST /api/me/wallet/sponsor", () => {
  it("401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    expect((await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }))).status).toBe(401);
  });
  it("400 on an invalid address", async () => {
    expect((await POST(postReq({ address: "x", signedXdr: "X" }))).status).toBe(400);
  });
  it("establishes the trustline", async () => {
    mockSubmit.mockResolvedValue({ hash: "H" });
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ established: true });
  });
  it("503 sponsorship_unavailable on op_low_reserve", async () => {
    mockSubmit.mockRejectedValue(new StellarPaymentError("x", "op_low_reserve", false));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("sponsorship_unavailable");
  });
  it("409 retry on tx_bad_seq", async () => {
    mockSubmit.mockRejectedValue(new StellarPaymentError("x", "tx_bad_seq", true));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("retry");
  });
  it("400 on invalid_sponsor_tx", async () => {
    mockSubmit.mockRejectedValue(new StellarPaymentError("x", "invalid_sponsor_tx", false));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_sponsor_tx");
  });
  it("502 on an unmapped StellarPaymentError code", async () => {
    mockSubmit.mockRejectedValue(new StellarPaymentError("x", "unknown_code", false));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("submit_failed");
  });
  // Distinct per-phase key so POST doesn't share GET's 15s bucket.
  it("429 when per-user rate limit fires on POST (sponsor-submit: key)", async () => {
    mockRateLimit.mockImplementation(async (key: string) => key.startsWith("sponsor-submit:"));
    const res = await POST(postReq({ address: ADDR, signedXdr: "SIGNED" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
  });
});
