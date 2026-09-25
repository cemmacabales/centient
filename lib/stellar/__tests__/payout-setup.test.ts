import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { WalletError, type WalletErrorCode } from "@/lib/stellar/wallet";
import {
  PAYOUT_SETUP_MESSAGES,
  setUpPayouts,
  type PayoutSetupDeps,
  type PayoutSetupFailure,
} from "@/lib/stellar/payout-setup";

const ADDR = Keypair.random().publicKey();
const URL = "/api/me/wallet/sponsor";

/** A JSON Response with the given status, as the API routes return. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** The sponsor route's throttled answer. */
const throttled = (retryAfter: string) => json(429, { error: "rate_limited" }, { "Retry-After": retryAfter });

type Answer = Response | (() => Response);

/**
 * Deps whose GETs and POSTs answer from queues, in order; the last answer repeats.
 * Defaults: the wallet needs sponsoring, and the submit is established.
 */
function makeDeps(opts: { gets?: Answer[]; posts?: Answer[]; overrides?: Partial<PayoutSetupDeps> } = {}) {
  const gets = opts.gets ?? [json(200, { needed: true, address: ADDR, xdr: "XDR", kind: "account+trustline" })];
  const posts = opts.posts ?? [json(200, { established: true })];
  const next = (queue: Answer[], i: number) => {
    const a = queue[Math.min(i, queue.length - 1)];
    return typeof a === "function" ? a() : a.clone();
  };
  let getN = 0;
  let postN = 0;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    init?.method === "POST" ? next(posts, postN++) : next(gets, getN++),
  );
  const onSigning = vi.fn();
  const onWaiting = vi.fn();
  const sleep = vi.fn(async () => {});
  const deps: PayoutSetupDeps = {
    signTransaction: vi.fn(async () => "SIGNED"),
    fetch: fetchMock as unknown as typeof fetch,
    onSigning,
    onWaiting,
    sleep,
    ...opts.overrides,
  };
  return { deps, fetchMock, onSigning, onWaiting, sleep };
}

/** The POSTs the flow made, as parsed bodies. */
const postedBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

describe("setUpPayouts — success", () => {
  it("is ready without a signature when the bound wallet already trusts USDC", async () => {
    const { deps, fetchMock } = makeDeps({ gets: [json(200, { needed: false, address: ADDR })] });

    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address: ADDR, sponsored: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(URL);
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it("co-signs the sponsored envelope for the bound address and submits it, sending no address", async () => {
    const { deps, fetchMock } = makeDeps();

    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address: ADDR, sponsored: true });

    expect(deps.signTransaction).toHaveBeenCalledWith("XDR", ADDR);
    expect(postedBodies(fetchMock)).toEqual([{ signedXdr: "SIGNED" }]);
  });

  it("reports the envelope kind while Freighter is open, and clears it after", async () => {
    const { deps, onSigning } = makeDeps({
      gets: [json(200, { needed: true, address: ADDR, xdr: "XDR", kind: "trustline" })],
    });
    await setUpPayouts(deps);
    expect(onSigning.mock.calls).toEqual([["trustline"], [null]]);
  });

  it("rebuilds and re-signs once when the submit answers retry", async () => {
    const { deps, fetchMock } = makeDeps({
      posts: [json(409, { error: "retry" }), json(200, { established: true })],
    });

    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address: ADDR, sponsored: true });

    expect(deps.signTransaction).toHaveBeenCalledTimes(2);
    expect(postedBodies(fetchMock)).toHaveLength(2);
  });
});

describe("setUpPayouts — a rate limit is a wait, not a failure", () => {
  it("waits out a throttled build for its Retry-After, then carries on", async () => {
    const { deps, fetchMock, onWaiting, sleep } = makeDeps({
      gets: [throttled("7"), json(200, { needed: true, address: ADDR, xdr: "XDR", kind: "trustline" })],
    });

    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address: ADDR, sponsored: true });

    expect(sleep).toHaveBeenCalledWith(7000);
    expect(onWaiting.mock.calls).toEqual([[7], [null]]);
    expect(fetchMock.mock.calls.filter(([, init]) => !init)).toHaveLength(2);
  });

  it("waits out a throttled submit and resends the same signed envelope, without signing again", async () => {
    const { deps, fetchMock, sleep } = makeDeps({ posts: [throttled("3"), json(200, { established: true })] });

    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address: ADDR, sponsored: true });

    expect(sleep).toHaveBeenCalledWith(3000);
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
    expect(postedBodies(fetchMock)).toEqual([{ signedXdr: "SIGNED" }, { signedXdr: "SIGNED" }]);
  });

  it("rebuilds after retry even when the rebuild is throttled (PR #105 review)", async () => {
    const { deps, sleep } = makeDeps({
      gets: [
        json(200, { needed: true, address: ADDR, xdr: "XDR", kind: "trustline" }),
        throttled("15"),
        json(200, { needed: true, address: ADDR, xdr: "XDR2", kind: "trustline" }),
      ],
      posts: [json(409, { error: "retry" }), json(200, { established: true })],
    });

    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: true, address: ADDR, sponsored: true });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(deps.signTransaction).toHaveBeenLastCalledWith("XDR2", ADDR);
  });

  it("waits once per request, then reports a limit that persists", async () => {
    const { deps, sleep } = makeDeps({ gets: [throttled("2")] });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason: "rate_limited" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no Retry-After", json(429, { error: "rate_limited" })],
    ["a Retry-After past the longest wait", throttled("600")],
    ["an unreadable Retry-After", throttled("soon")],
    ["the sponsorship cap, which no wait clears", json(429, { error: "sponsorship_cap_reached" }, { "Retry-After": "5" })],
  ])("reports rather than waits for %s", async (_label, answer) => {
    const { deps, sleep } = makeDeps({ gets: [answer] });
    const result = await setUpPayouts(deps);
    expect(result.ok).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("setUpPayouts — recoverable failures", () => {
  it("gives up after a second retry rather than looping", async () => {
    const { deps, fetchMock } = makeDeps({ posts: [json(409, { error: "retry" })] });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(postedBodies(fetchMock)).toHaveLength(2);
  });

  it("answers pending on a 202 and does not rebuild — rebuilding could sponsor twice", async () => {
    const { deps, fetchMock } = makeDeps({ posts: [json(202, { established: false, pending: true })] });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason: "pending" });
    expect(postedBodies(fetchMock)).toHaveLength(1);
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
  });

  it.each<[WalletErrorCode, PayoutSetupFailure]>([
    ["rejected", "rejected"],
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
    ["wrong_account", "wrong_account"],
    ["freighter_missing", "freighter_missing"],
    ["unsupported", "failed"],
  ])("maps a %s signing error to %s and submits nothing", async (code, reason) => {
    const { deps, fetchMock, onSigning } = makeDeps({
      overrides: { signTransaction: vi.fn(async () => { throw new WalletError(code, "x"); }) },
    });

    await expect(setUpPayouts({ ...deps, onSigning })).resolves.toEqual({ ok: false, reason });

    expect(postedBodies(fetchMock)).toHaveLength(0);
    expect(onSigning).toHaveBeenLastCalledWith(null);
  });

  it.each<[number, string | undefined, PayoutSetupFailure]>([
    [409, "wallet_required", "wallet_required"],
    [409, "address_in_use", "address_in_use"],
    [409, "submission_pending", "pending"],
    [429, "sponsorship_cap_reached", "cap_reached"],
    [429, "rate_limited", "rate_limited"],
    [503, "sponsorship_unavailable", "unavailable"],
    [502, "build_failed", "failed"],
    [401, "unauthorized", "failed"],
  ])("maps a %i %s from the build to %s without signing", async (status, error, reason) => {
    const { deps } = makeDeps({ gets: [json(status, { error })] });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason });
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it.each<[number, string, PayoutSetupFailure]>([
    [409, "address_in_use", "address_in_use"],
    [409, "submission_pending", "pending"],
    [429, "sponsorship_cap_reached", "cap_reached"],
    [503, "sponsorship_unavailable", "unavailable"],
    [400, "invalid_sponsor_tx", "failed"],
    [502, "submit_failed", "failed"],
  ])("maps a %i %s from the submit to %s", async (status, error, reason) => {
    const { deps } = makeDeps({ posts: [json(status, { error })] });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason });
  });

  it("answers network when a request never reaches the server", async () => {
    const { deps } = makeDeps({
      overrides: { fetch: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch },
    });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason: "network" });
  });

  it("fails rather than signing when the build answer is malformed", async () => {
    const { deps } = makeDeps({ gets: [json(200, { needed: true, address: ADDR })] });
    await expect(setUpPayouts(deps)).resolves.toEqual({ ok: false, reason: "failed" });
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it("has a message for every failure", () => {
    const reasons: PayoutSetupFailure[] = [
      "wallet_required", "freighter_missing", "rejected", "cancelled", "timed_out", "wrong_account", "pending", "cap_reached",
      "address_in_use", "unavailable", "rate_limited", "network", "failed",
    ];
    for (const reason of reasons) expect(PAYOUT_SETUP_MESSAGES[reason]).toBeTruthy();
  });
});
