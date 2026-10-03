import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { WalletError, type WalletErrorCode } from "@/lib/stellar/wallet";
import {
  WALLET_SIGN_IN_MESSAGES,
  signInWithWallet,
  type WalletSignInDeps,
  type WalletSignInFailure,
} from "@/lib/stellar/wallet-sign-in";

const ADDR = Keypair.random().publicKey();
const CHALLENGE = { nonce: "a".repeat(32), message: "Centient: prove…", expiresAt: "2026-09-14T09:05:00.000Z" };

/** A JSON Response with the given status, as the API routes return. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Deps for a flow where every step succeeds unless a test overrides it. */
function makeDeps(overrides: Partial<WalletSignInDeps> = {}) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === "/api/auth/wallet/challenge") return json(200, CHALLENGE);
    return json(200, { success: true, userId: "u1", walletAddress: ADDR, created: true });
  });
  const deps = {
    connect: vi.fn(async () => ({ address: ADDR, wallet: "freighter" as const })),
    signOwnership: vi.fn(async () => ({
      address: ADDR,
      signature: "c2ln",
      scheme: "sep53" as const,
      wallet: "freighter" as const,
    })),
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
  return { deps, fetchMock };
}

/** The parsed JSON body the flow sent to `url`, or undefined if it never called it. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, url: string): unknown {
  const call = fetchMock.mock.calls.find(([u]) => String(u) === url);
  return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}

describe("signInWithWallet — success", () => {
  it("connects, requests a challenge, signs it and verifies the proof", async () => {
    const { deps, fetchMock } = makeDeps();

    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: true, address: ADDR, created: true });

    expect(bodyOf(fetchMock, "/api/auth/wallet/challenge")).toEqual({ address: ADDR });
    // A stored mobile session may be one Freighter no longer holds.
    expect(deps.connect).toHaveBeenCalledWith({ fresh: true });
    expect(deps.signOwnership).toHaveBeenCalledWith(CHALLENGE.message, ADDR);
    expect(bodyOf(fetchMock, "/api/auth/wallet/verify")).toEqual({
      address: ADDR,
      nonce: CHALLENGE.nonce,
      signature: "c2ln",
      signerAddress: ADDR,
    });
  });

  it("reports a returning contributor as not created", async () => {
    const { deps } = makeDeps({
      fetch: (async (url: string | URL | Request) =>
        String(url).endsWith("/challenge")
          ? json(200, CHALLENGE)
          : json(200, { success: true, created: false })) as typeof fetch,
    });
    await expect(signInWithWallet(deps)).resolves.toMatchObject({ ok: true, created: false });
  });

  it("sends the G… address exactly as Freighter returned it", async () => {
    const { deps, fetchMock } = makeDeps();
    await signInWithWallet(deps);
    const sent = bodyOf(fetchMock, "/api/auth/wallet/challenge") as { address: string };
    expect(sent.address).toBe(ADDR);
    expect(sent.address).not.toBe(ADDR.toLowerCase());
  });
});

describe("signInWithWallet — wallet failures", () => {
  const cases: [WalletErrorCode, WalletSignInFailure][] = [
    ["freighter_missing", "freighter_missing"],
    ["rejected", "rejected"],
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
    ["wrong_account", "wrong_account"],
    ["unsupported", "unsupported"],
    ["invalid_address", "failed"],
    ["failed", "failed"],
  ];

  it.each(cases)("connect throwing %s resolves to %s without calling the API", async (code, reason) => {
    const { deps, fetchMock } = makeDeps({
      connect: vi.fn(async () => {
        throw new WalletError(code, "boom");
      }),
    });
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a declined signature resolves to rejected and never calls verify", async () => {
    const { deps, fetchMock } = makeDeps({
      signOwnership: vi.fn(async () => {
        throw new WalletError("rejected", "The user rejected this request.");
      }),
    });
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(bodyOf(fetchMock, "/api/auth/wallet/verify")).toBeUndefined();
  });

  it("signing with another account resolves to wrong_account", async () => {
    const { deps } = makeDeps({
      signOwnership: vi.fn(async () => {
        throw new WalletError("wrong_account", "Signed with the wrong account");
      }),
    });
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "wrong_account" });
  });

  it("an unexpected non-wallet error resolves to failed", async () => {
    const { deps } = makeDeps({
      connect: vi.fn(async () => {
        throw new Error("something else");
      }),
    });
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "failed" });
  });
});

describe("signInWithWallet — server responses", () => {
  /** Deps whose challenge call returns (or throws) `challenge` and whose verify returns `verify`. */
  function withResponses(challenge: Response | Error, verify?: Response) {
    return makeDeps({
      fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith("/challenge")) {
          if (challenge instanceof Error) throw challenge;
          return challenge;
        }
        return verify ?? json(200, { success: true, created: false });
      }) as typeof fetch,
    });
  }

  it("a throttled challenge resolves to rate_limited and never opens Freighter's signing prompt", async () => {
    const { deps } = withResponses(json(429, { error: "rate_limited" }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "rate_limited" });
    expect(deps.signOwnership).not.toHaveBeenCalled();
  });

  it("any other challenge error resolves to failed", async () => {
    const { deps } = withResponses(json(400, { error: "invalid_address" }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("a challenge body without nonce or message resolves to failed", async () => {
    const { deps } = withResponses(json(200, { nonce: 1 }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(deps.signOwnership).not.toHaveBeenCalled();
  });

  it("an unreachable server resolves to network", async () => {
    const { deps } = withResponses(new TypeError("Failed to fetch"));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "network" });
  });

  it.each([
    ["challenge_expired", "expired"],
    ["challenge_not_found", "expired"],
    ["wrong_signer", "wrong_account"],
    ["wrong_address", "wrong_account"],
    ["wrong_network", "failed"],
    ["bad_signature", "failed"],
  ])("verify rejecting with %s resolves to %s", async (error, reason) => {
    const { deps } = withResponses(json(200, CHALLENGE), json(401, { error }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason });
  });

  it("a banned identity resolves to banned, not to a retry", async () => {
    // #36 added a 403 `banned` to verify. Mapping it to `failed` would invite
    // an attempt that can never succeed.
    const { deps } = withResponses(json(200, CHALLENGE), json(403, { error: "banned" }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "banned" });
  });

  it("a 403 that is not a ban stays failed", async () => {
    const { deps } = withResponses(json(200, CHALLENGE), json(403, { error: "forbidden" }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("a verify error without a JSON body resolves to failed", async () => {
    const { deps } = withResponses(json(200, CHALLENGE), new Response("<html>", { status: 502 }));
    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "failed" });
  });
});

describe("WALLET_SIGN_IN_MESSAGES", () => {
  it("tells a banned contributor where to go instead of to try again", () => {
    expect(WALLET_SIGN_IN_MESSAGES.banned).not.toMatch(/try again/i);
    expect(WALLET_SIGN_IN_MESSAGES.banned).toMatch(/centient@artisam\.xyz/);
  });

  it("has actionable copy for every failure", () => {
    const reasons: WalletSignInFailure[] = [
      "freighter_missing",
      "rejected",
      "cancelled",
      "timed_out",
      "wrong_account",
      "unsupported",
      "wrong_network",
      "expired",
      "rate_limited",
      "network",
      "failed",
    ];
    for (const reason of reasons) {
      expect(WALLET_SIGN_IN_MESSAGES[reason]).toMatch(/try again/i);
    }
  });
});

describe("signInWithWallet — payout setup's signature in the same visit (#170)", () => {
  const OFFER = {
    xdr: "OFFERED-XDR",
    kind: "trustline",
    offer: "TAG",
    expiresAt: "2026-09-30T12:03:00.000Z",
  };
  const PROOF = { address: ADDR, signature: "Ym90aA==", scheme: "sep53" as const, wallet: "freighter" as const };

  /** Deps on the mobile app, whose challenge offers `sponsorship` and whose verify answers `verify`. */
  function mobileDeps(o: { sponsorship?: unknown; verify?: Response; batches?: boolean } = {}) {
    const signedTransaction = vi.fn(async () => "CO-SIGNED");
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "/api/auth/wallet/challenge") {
        return json(200, { ...CHALLENGE, ...(o.sponsorship !== undefined && { sponsorship: o.sponsorship }) });
      }
      return o.verify?.clone() ?? json(200, { success: true, userId: "u1", walletAddress: ADDR, created: true });
    });
    const { deps } = makeDeps({
      fetch: fetchMock as unknown as typeof fetch,
      batchesSignatures: vi.fn(async () => o.batches ?? true),
      signOwnershipAndTransaction: vi.fn(async () => ({ proof: PROOF, signedTransaction })),
      handOffPayoutSignature: vi.fn(),
    });
    return { deps, fetchMock, signedTransaction };
  }

  it("asks for the offer, signs both at once, and hands the transaction to payout setup", async () => {
    const { deps, fetchMock, signedTransaction } = mobileDeps({ sponsorship: OFFER });

    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: true, address: ADDR, created: true });

    expect(bodyOf(fetchMock, "/api/auth/wallet/challenge")).toEqual({ address: ADDR, payoutSetup: true });
    expect(deps.signOwnershipAndTransaction).toHaveBeenCalledWith(CHALLENGE.message, "OFFERED-XDR", ADDR);
    expect(deps.signOwnership).not.toHaveBeenCalled();
    expect(bodyOf(fetchMock, "/api/auth/wallet/verify")).toMatchObject({ signature: "Ym90aA==", signerAddress: ADDR });
    expect(deps.handOffPayoutSignature).toHaveBeenCalledWith({
      address: ADDR,
      kind: "trustline",
      offer: "TAG",
      expiresAt: Date.parse(OFFER.expiresAt),
      signedTransaction,
    });
    // Sign-in doesn't wait on the transaction: payout setup collects it.
    expect(signedTransaction).not.toHaveBeenCalled();
  });

  it("hands over only once verify has signed the contributor in", async () => {
    const { deps, fetchMock } = mobileDeps({ sponsorship: OFFER });
    vi.mocked(deps.handOffPayoutSignature!).mockImplementation(() => {
      expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/auth/wallet/verify");
    });
    await signInWithWallet(deps);
    expect(deps.handOffPayoutSignature).toHaveBeenCalledTimes(1);
  });

  it("signs the message alone when the challenge offers nothing (the wallet already trusts USDC)", async () => {
    const { deps } = mobileDeps();

    await expect(signInWithWallet(deps)).resolves.toMatchObject({ ok: true });

    expect(deps.signOwnership).toHaveBeenCalledWith(CHALLENGE.message, ADDR);
    expect(deps.signOwnershipAndTransaction).not.toHaveBeenCalled();
    expect(deps.handOffPayoutSignature).not.toHaveBeenCalled();
  });

  it.each([
    ["no offer tag", { ...OFFER, offer: undefined }],
    ["no envelope", { ...OFFER, xdr: "" }],
    ["an unreadable expiry", { ...OFFER, expiresAt: "soon" }],
    ["not an object", "OFFERED-XDR"],
  ])("ignores an offer with %s, and signs the message alone", async (_name, sponsorship) => {
    const { deps } = mobileDeps({ sponsorship });

    await expect(signInWithWallet(deps)).resolves.toMatchObject({ ok: true });

    expect(deps.signOwnership).toHaveBeenCalled();
    expect(deps.signOwnershipAndTransaction).not.toHaveBeenCalled();
  });

  it("doesn't ask for the offer where signatures don't cost a trip (the extension)", async () => {
    const { deps, fetchMock } = mobileDeps({ sponsorship: OFFER, batches: false });

    await signInWithWallet(deps);

    expect(bodyOf(fetchMock, "/api/auth/wallet/challenge")).toEqual({ address: ADDR });
    expect(deps.signOwnershipAndTransaction).not.toHaveBeenCalled();
    expect(deps.handOffPayoutSignature).not.toHaveBeenCalled();
  });

  it("hands nothing over when verify refuses the proof", async () => {
    const { deps } = mobileDeps({ sponsorship: OFFER, verify: json(401, { error: "challenge_expired" }) });

    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "expired" });
    expect(deps.handOffPayoutSignature).not.toHaveBeenCalled();
  });

  it("reports a declined message as a declined sign-in", async () => {
    const { deps } = mobileDeps({ sponsorship: OFFER });
    vi.mocked(deps.signOwnershipAndTransaction!).mockRejectedValue(
      new WalletError("rejected", "You declined the request in Freighter."),
    );

    await expect(signInWithWallet(deps)).resolves.toEqual({ ok: false, reason: "rejected" });
    expect(deps.handOffPayoutSignature).not.toHaveBeenCalled();
  });
});
