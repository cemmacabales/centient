import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { WalletError, type WalletErrorCode } from "@/lib/stellar/wallet";
import {
  WALLET_CLAIM_MESSAGES,
  claimWallet,
  type WalletClaimDeps,
  type WalletClaimFailure,
} from "@/lib/stellar/wallet-claim";

const ADDR = Keypair.random().publicKey();
const CHALLENGE = { message: "Instawards: link this Stellar address…", nonce: "n".repeat(32) };

/** A JSON Response with the given status, as the API routes return. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Deps for a claim where every step succeeds unless a test overrides it. */
function makeDeps(opts: { challenge?: Response; bind?: Response; overrides?: Partial<WalletClaimDeps> } = {}) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    init?.method === "POST"
      ? (opts.bind ?? json(200, { linked: true, walletAddress: ADDR }))
      : (opts.challenge ?? json(200, CHALLENGE)),
  );
  const deps: WalletClaimDeps = {
    connect: vi.fn(async () => ({ address: ADDR, wallet: "freighter" as const })),
    signOwnership: vi.fn(async () => ({
      address: ADDR,
      signature: "c2ln",
      scheme: "sep53" as const,
      wallet: "freighter" as const,
    })),
    fetch: fetchMock as unknown as typeof fetch,
    ...opts.overrides,
  };
  return { deps, fetchMock };
}

describe("claimWallet — success", () => {
  it("connects, fetches a link challenge for the address, signs it and binds the proof", async () => {
    const { deps, fetchMock } = makeDeps();

    await expect(claimWallet(deps)).resolves.toEqual({ ok: true, address: ADDR });

    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/me/wallet?address=${encodeURIComponent(ADDR)}`);
    expect(deps.signOwnership).toHaveBeenCalledWith(CHALLENGE.message, ADDR);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("/api/me/wallet");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ stellarAddress: ADDR, signature: "c2ln" });
  });
});

describe("claimWallet — failures", () => {
  it.each<[WalletErrorCode, WalletClaimFailure]>([
    ["freighter_missing", "freighter_missing"],
    ["rejected", "rejected"],
    ["wrong_account", "wrong_account"],
    ["unsupported", "unsupported"],
    ["invalid_address", "failed"],
  ])("maps a %s connect error to %s without calling the server", async (code, reason) => {
    const { deps, fetchMock } = makeDeps({
      overrides: { connect: vi.fn(async () => { throw new WalletError(code, "x"); }) },
    });
    await expect(claimWallet(deps)).resolves.toEqual({ ok: false, reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a declined signature to rejected and binds nothing", async () => {
    const { deps, fetchMock } = makeDeps({
      overrides: { signOwnership: vi.fn(async () => { throw new WalletError("rejected", "x"); }) },
    });
    await expect(claimWallet(deps)).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each<[number, WalletClaimFailure]>([
    [429, "rate_limited"],
    [400, "failed"],
    [401, "failed"],
  ])("maps a %i challenge refusal to %s without signing", async (status, reason) => {
    const { deps } = makeDeps({ challenge: json(status, { error: "x" }) });
    await expect(claimWallet(deps)).resolves.toEqual({ ok: false, reason });
    expect(deps.signOwnership).not.toHaveBeenCalled();
  });

  it.each<[number, string, WalletClaimFailure]>([
    [400, "challenge_expired", "expired"],
    [409, "address_already_linked", "address_in_use"],
    [409, "wallet_already_bound", "wallet_already_bound"],
    [429, "rate_limited", "rate_limited"],
    [401, "invalid_signature", "failed"],
  ])("maps a %i %s bind refusal to %s", async (status, error, reason) => {
    const { deps } = makeDeps({ bind: json(status, { error }) });
    await expect(claimWallet(deps)).resolves.toEqual({ ok: false, reason });
  });

  it("answers network when a request never reaches the server", async () => {
    const { deps } = makeDeps({
      overrides: { fetch: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch },
    });
    await expect(claimWallet(deps)).resolves.toEqual({ ok: false, reason: "network" });
  });

  it("fails rather than signing a malformed challenge", async () => {
    const { deps } = makeDeps({ challenge: json(200, { nonce: "n" }) });
    await expect(claimWallet(deps)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(deps.signOwnership).not.toHaveBeenCalled();
  });

  it("has a message for every failure", () => {
    const reasons: WalletClaimFailure[] = [
      "freighter_missing", "rejected", "wrong_account", "unsupported", "expired", "address_in_use",
      "wallet_already_bound", "rate_limited", "network", "failed",
    ];
    for (const reason of reasons) expect(WALLET_CLAIM_MESSAGES[reason]).toBeTruthy();
  });
});
