import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";
import { resetRecentPayoutsCache } from "@/lib/recent-payouts";

const ACCOUNT = "GC5UOTESTPAYOUTACCOUNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAR4A6";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function horizonPage(records: unknown[]) {
  return new Response(JSON.stringify({ _embedded: { records } }), { status: 200 });
}

describe("GET /api/payouts/recent", () => {
  beforeEach(() => {
    resetRecentPayoutsCache();
    vi.stubEnv("STELLAR_NETWORK", "testnet");
    vi.stubEnv("STELLAR_USDC_ISSUER", ISSUER);
    vi.stubEnv("STELLAR_PLATFORM_ACCOUNT", ACCOUNT);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("serves the payout account's USDC payouts from Horizon", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      horizonPage([
        {
          id: "7",
          type: "payment",
          created_at: "2026-09-11T08:40:02Z",
          transaction_hash: "abc123",
          transaction_successful: true,
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: ISSUER,
          from: ACCOUNT,
          to: "GCP34LABELERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWXYZ",
          amount: "0.0500000",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://horizon-testnet.stellar.org/accounts/${ACCOUNT}/payments?order=desc&limit=50`,
    );
    expect(await res.json()).toEqual({
      network: "testnet",
      accountUrl: `https://stellar.expert/explorer/testnet/account/${ACCOUNT}`,
      payouts: [
        {
          id: "7",
          amount: "0.05",
          to: "GCP3…WXYZ",
          tx: "abc123",
          at: "2026-09-11T08:40:02Z",
          txUrl: "https://stellar.expert/explorer/testnet/tx/abc123",
        },
      ],
    });
  });

  it("serves an empty feed, not an error, when no payout account is configured", async () => {
    vi.stubEnv("STELLAR_PLATFORM_ACCOUNT", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ network: "testnet", accountUrl: null, payouts: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports 502 when Horizon cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await GET();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "horizon_unavailable" });
  });

  it("reuses one Horizon read across requests for a short while", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => horizonPage([]));
    vi.stubGlobal("fetch", fetchMock);

    await GET();
    await GET();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
