import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRecentPayouts,
  formatPayoutAmount,
  resetRecentPayoutsCache,
  toRecentPayouts,
  type HorizonPaymentRecord,
} from "../recent-payouts";

const ACCOUNT = "GC5UOTESTPAYOUTACCOUNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAR4A6";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const LABELER = "GA4XSLABELERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZVN";
const EXPLORER = "https://stellar.expert/explorer/testnet";

function payment(overrides: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  return {
    id: "1",
    type: "payment",
    created_at: "2026-09-08T04:09:47Z",
    transaction_hash: "9f6b8ae9aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff",
    transaction_successful: true,
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: ISSUER,
    from: ACCOUNT,
    to: LABELER,
    amount: "0.1000000",
    ...overrides,
  };
}

const options = { account: ACCOUNT, usdcCode: "USDC", usdcIssuer: ISSUER, explorer: EXPLORER };

describe("toRecentPayouts", () => {
  it("keeps a USDC payment sent from the payout account, without the full recipient", () => {
    const [payout] = toRecentPayouts([payment()], options);

    expect(payout).toEqual({
      id: "1",
      amount: "0.10",
      to: "GA4X…KZVN",
      tx: "9f6b…eeff",
      at: "2026-09-08T04:09:47Z",
      txUrl: `${EXPLORER}/tx/9f6b8ae9aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff`,
    });
    expect(JSON.stringify(payout)).not.toContain(LABELER);
  });

  it("drops payments into the account, other assets, other operations and failed transactions", () => {
    const payouts = toRecentPayouts(
      [
        payment({ id: "in", from: LABELER, to: ACCOUNT }),
        payment({ id: "fake-usdc", asset_issuer: LABELER }),
        payment({ id: "xlm", asset_type: "native", asset_code: undefined, asset_issuer: undefined }),
        payment({ id: "create", type: "create_account" }),
        payment({ id: "failed", transaction_successful: false }),
        payment({ id: "kept" }),
      ],
      options,
    );

    expect(payouts.map((p) => p.id)).toEqual(["kept"]);
  });

  it("returns at most the requested number, newest first as Horizon ordered them", () => {
    const records = ["a", "b", "c", "d"].map((id) => payment({ id }));

    expect(toRecentPayouts(records, { ...options, limit: 2 }).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("formatPayoutAmount", () => {
  it("shows amounts in cents, rounding half up", () => {
    expect(formatPayoutAmount("0.1000000")).toBe("0.10");
    expect(formatPayoutAmount("0.0500000")).toBe("0.05");
    expect(formatPayoutAmount("6.0099999")).toBe("6.01");
    expect(formatPayoutAmount("10.0000000")).toBe("10.00");
    expect(formatPayoutAmount("0.2450000")).toBe("0.25");
    expect(formatPayoutAmount("9.9950000")).toBe("10.00");
  });

  it("keeps the digits of an amount too small to show in cents", () => {
    expect(formatPayoutAmount("0.0040000")).toBe("0.004");
    expect(formatPayoutAmount("0.0000001")).toBe("0.0000001");
  });
});

describe("fetchRecentPayouts", () => {
  afterEach(() => {
    resetRecentPayoutsCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A Horizon that answers only when `release` is called, counting reads. */
  function slowHorizon() {
    vi.stubEnv("STELLAR_PLATFORM_ACCOUNT", ACCOUNT);
    vi.stubEnv("STELLAR_USDC_ISSUER", ISSUER);
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn(async () => {
      await answered;
      return new Response(JSON.stringify({ _embedded: { records: [payment()] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    return { fetch, release };
  }

  it("shares one Horizon read between visitors who arrive while the cache is cold", async () => {
    const { fetch, release } = slowHorizon();

    const visitors = Promise.all([fetchRecentPayouts(0), fetchRecentPayouts(1), fetchRecentPayouts(2)]);
    release();
    const results = await visitors;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results[0].payouts).toHaveLength(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it("reads again once a failed shared read has settled", async () => {
    vi.stubEnv("STELLAR_PLATFORM_ACCOUNT", ACCOUNT);
    vi.stubEnv("STELLAR_USDC_ISSUER", ISSUER);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(Promise.all([fetchRecentPayouts(0), fetchRecentPayouts(1)])).rejects.toThrow("horizon_503");
    await expect(fetchRecentPayouts(2)).resolves.toMatchObject({ payouts: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
