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
});

describe("POST /api/me/wallet/sponsor", () => {
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
});
