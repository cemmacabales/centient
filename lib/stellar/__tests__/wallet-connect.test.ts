// Freighter mobile over WalletConnect. The provider is injected, so these run
// without a relay, a project id or a phone — what is under test is the contract
// this app holds with the wallet: the CAIP chain it asks to sign on, the method
// names and param shapes, and the checks that stand in for the `signerAddress`
// the mobile wallet (unlike the extension) never sends back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";

process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

import {
  PAIRING_TIMEOUT_MS,
  DROP_SESSION_WAIT_MS,
  REQUEST_TIMEOUT_MS,
  cancelPairing,
  cancelWalletRequest,
  connect,
  formatNativeUrl,
  isFreighterInAppBrowser,
  isWalletConnectConfigured,
  onPairing,
  setWalletConnectProvider,
  signOwnership,
  signTransaction,
  pairingIsPending,
  resetMobileLinkCache,
  type WalletConnectProvider,
} from "@/lib/stellar/wallet-connect";
import { WalletError } from "@/lib/stellar/wallet-errors";

const kp = Keypair.fromSecret("SDBTJCPJ27TY3BNTANZ3G52FBGCQE76QRP7E2WZQRZLG7GJJBULSQ75E");
const ADDR = kp.publicKey();
const OTHER = Keypair.random().publicKey();
const MESSAGE = "Sign in to Centient — nonce 12345";
const CHAIN = "stellar:testnet";

/** Sign `message` the way Freighter mobile does: SEP-53, base64. */
function sep53Sign(message: string, keypair = kp): string {
  const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
  return keypair.sign(hash(Buffer.concat([prefix, Buffer.from(message, "utf8")]))).toString("base64");
}

/** A stand-in provider with a live session for `accounts` on the active chain. */
function fakeProvider(
  overrides: Partial<WalletConnectProvider> & { accounts?: string[] } = {},
): WalletConnectProvider & { request: ReturnType<typeof vi.fn> } {
  const { accounts, ...rest } = overrides;
  return {
    session:
      accounts === undefined
        ? undefined
        : { namespaces: { stellar: { accounts: accounts.map((a) => `${CHAIN}:${a}`) } } },
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    ...rest,
  } as WalletConnectProvider & { request: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
  process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
});

afterEach(() => {
  cancelPairing(); // a test that left an attempt waiting mustn't hand it to the next
  setWalletConnectProvider(null);
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
});

describe("isWalletConnectConfigured", () => {
  it("is false without a project id, so the mobile path stays off", () => {
    delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    expect(isWalletConnectConfigured()).toBe(false);
  });

  it("treats a blank project id as unconfigured", () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "   ";
    expect(isWalletConnectConfigured()).toBe(false);
  });

  it("is true once a project id is set", () => {
    expect(isWalletConnectConfigured()).toBe(true);
  });
});

describe("connect", () => {
  it("proposes the stellar namespace on the configured chain", async () => {
    const provider = fakeProvider();
    // The session appears once the wallet approves the proposal.
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
      return Promise.resolve(undefined);
    });
    setWalletConnectProvider(provider);

    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    expect(provider.connect).toHaveBeenCalledWith({
      namespaces: {
        stellar: {
          chains: [CHAIN],
          methods: [
            "stellar_signXDR",
            "stellar_signAndSubmitXDR",
            "stellar_signMessage",
            "stellar_signAuthEntry",
          ],
          events: ["accountsChanged"],
        },
      },
    });
  });

  it("asks for stellar:pubnet on a mainnet build", async () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "public";
    const provider = fakeProvider();
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = {
        namespaces: { stellar: { accounts: [`stellar:pubnet:${ADDR}`] } },
      };
      return Promise.resolve(undefined);
    });
    setWalletConnectProvider(provider);

    await connect();
    expect(provider.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        namespaces: expect.objectContaining({
          stellar: expect.objectContaining({ chains: ["stellar:pubnet"] }),
        }),
      }),
    );
  });

  it("reuses a live session instead of pairing again", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    setWalletConnectProvider(provider);

    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it("reports wrong_network when the wallet approves on another chain", async () => {
    const provider = fakeProvider();
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = {
        namespaces: { stellar: { accounts: [`stellar:pubnet:${ADDR}`] } },
      };
      return Promise.resolve(undefined);
    });
    setWalletConnectProvider(provider);

    await expect(connect()).rejects.toMatchObject({ code: "wrong_network" });
  });

  it("maps the user declining the pairing to `rejected`", async () => {
    const provider = fakeProvider();
    provider.connect = vi.fn().mockRejectedValue(
      Object.assign(new Error("User rejected."), { code: 5000 }),
    );
    setWalletConnectProvider(provider);

    await expect(connect()).rejects.toMatchObject({ code: "rejected" });
  });

  it("clears the pairing prompt once the attempt settles", async () => {
    const seen: (unknown | null)[] = [];
    const unsubscribe = onPairing((p) => seen.push(p));
    const provider = fakeProvider();
    provider.connect = vi.fn().mockRejectedValue(new Error("relay down"));
    setWalletConnectProvider(provider);

    await expect(connect()).rejects.toBeInstanceOf(WalletError);
    expect(seen.at(-1)).toBeNull();
    unsubscribe();
  });
});

describe("connect — an abandoned pairing", () => {
  /** A provider whose pairing the wallet never answers. */
  function silentProvider(): WalletConnectProvider {
    const provider = fakeProvider();
    provider.connect = vi.fn(() => new Promise<never>(() => {}));
    return provider;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up with timed_out once the wallet has been silent too long", async () => {
    vi.useFakeTimers();
    setWalletConnectProvider(silentProvider());

    const attempt = expect(connect()).rejects.toMatchObject({ code: "timed_out" });
    await vi.advanceTimersByTimeAsync(PAIRING_TIMEOUT_MS);
    await attempt;
  });

  it("is still waiting just before the timeout", async () => {
    vi.useFakeTimers();
    setWalletConnectProvider(silentProvider());

    let settled = false;
    const attempt = connect().finally(() => {
      settled = true;
    });
    attempt.catch(() => {});
    await vi.advanceTimersByTimeAsync(PAIRING_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    cancelPairing();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
  });

  it("stops at once with cancelled when the contributor cancels", async () => {
    setWalletConnectProvider(silentProvider());

    const attempt = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
  });

  it("closes the pairing prompt when it gives up", async () => {
    const seen: (unknown | null)[] = [];
    const unsubscribe = onPairing((p) => seen.push(p));
    setWalletConnectProvider(silentProvider());

    const attempt = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(attempt).rejects.toBeInstanceOf(WalletError);
    expect(seen.at(-1)).toBeNull();
    unsubscribe();
  });

  it("pairs afresh on the next attempt", async () => {
    const provider = silentProvider();
    setWalletConnectProvider(provider);

    const first = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
      return Promise.resolve(undefined);
    });
    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
  });

  it("does nothing when no pairing is pending", () => {
    expect(() => cancelPairing()).not.toThrow();
    expect(pairingIsPending()).toBe(false);
  });
});

describe("connect — a retry after an abandoned pairing", () => {
  it("completes when the wallet approves the earlier pairing instead", async () => {
    // Each proposal is answered by hand: the first attempt's QR can reach the
    // screen late, after the retry started, and be the one the user scans.
    const answers: (() => void)[] = [];
    const provider = fakeProvider();
    provider.connect = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          answers.push(() => {
            provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
            resolve(undefined);
          });
        }),
    );
    setWalletConnectProvider(provider);

    const first = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    const retry = connect();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0](); // the wallet approves the first proposal, not the retry's

    await expect(retry).resolves.toEqual({ address: ADDR, wallet: "freighter" });
  });

  it("ignores a proposal left on a provider that was since replaced", async () => {
    const answers: (() => void)[] = [];
    const old = fakeProvider();
    old.connect = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          answers.push(() => {
            old.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
            resolve(undefined);
          });
        }),
    );
    setWalletConnectProvider(old);

    const first = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    // e.g. after disconnect(): the next attempt runs on a fresh provider.
    const fresh = fakeProvider();
    fresh.connect = vi.fn(() => new Promise<never>(() => {}));
    setWalletConnectProvider(fresh);

    const retry = connect();
    retry.catch(() => {});
    await vi.waitFor(() => expect(fresh.connect).toHaveBeenCalled());
    answers[0](); // the session lands on the discarded provider, not this one
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pairingIsPending()).toBe(true);
    cancelPairing();
    await expect(retry).rejects.toMatchObject({ code: "cancelled" });
  });

  it("is not failed by the earlier pairing failing", async () => {
    const fails: ((err: Error) => void)[] = [];
    const provider = fakeProvider();
    provider.connect = vi.fn(
      () => new Promise<unknown>((_, reject) => fails.push(reject)),
    );
    setWalletConnectProvider(provider);

    const first = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    const retry = connect();
    retry.catch(() => {});
    await vi.waitFor(() => expect(fails).toHaveLength(2));
    fails[0](new Error("Proposal expired"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pairingIsPending()).toBe(true);
    cancelPairing();
    await expect(retry).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("connect — relay news that lands after the attempt ended", () => {
  /** A wallet that never answers, whose pairing URI we deliver by hand. */
  function silentProvider(): WalletConnectProvider {
    const provider = fakeProvider();
    provider.connect = vi.fn(() => new Promise<never>(() => {}));
    return provider;
  }

  /** The `display_uri` listener the transport registered on `provider`. */
  function displayUri(provider: WalletConnectProvider): (uri: string) => void {
    const call = vi.mocked(provider.on).mock.calls.find(([event]) => event === "display_uri");
    if (!call) throw new Error("no display_uri listener registered");
    return call[1] as unknown as (uri: string) => void;
  }

  /** Let pending promise callbacks and a macrotask run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    vi.restoreAllMocks();
    resetMobileLinkCache();
  });

  it("ignores a pairing URI the relay delivers after a cancel", async () => {
    const seen: (unknown | null)[] = [];
    const unsubscribe = onPairing((p) => seen.push(p));
    const provider = silentProvider();
    setWalletConnectProvider(provider);

    const attempt = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelPairing();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });

    seen.length = 0;
    displayUri(provider)("wc:late@2?relay-protocol=irn&symKey=00");
    await settle();

    // Reopening the prompt here would strand the contributor: nothing is
    // pending, so Cancel could no longer close it.
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it("drops the deep link when the attempt ended while it was being looked up", async () => {
    let answer: (res: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    const seen: (unknown | null)[] = [];
    const unsubscribe = onPairing((p) => seen.push(p));
    const provider = silentProvider();
    setWalletConnectProvider(provider);

    const attempt = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    displayUri(provider)("wc:abc@2?relay-protocol=irn&symKey=00");
    // The QR can draw straight away; the deep link waits on the registry.
    expect(seen.at(-1)).toMatchObject({ deepLink: null });

    cancelPairing();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });

    seen.length = 0;
    answer(
      new Response(
        JSON.stringify({ listings: { f: { name: "Freighter", mobile: { native: "freighterwallet://" } } } }),
        { status: 200 },
      ),
    );
    await settle();

    expect(seen).toEqual([]);
    unsubscribe();
  });
});

describe("connect — a fresh pairing", () => {
  it("drops a stored session and pairs again, so the wallet is asked, not assumed", async () => {
    // The stored session can be one Freighter no longer holds: requests over it
    // are dropped there without a word, which is the hang this exists to avoid.
    const provider = fakeProvider({ accounts: [OTHER] });
    provider.disconnect = vi.fn(async () => {
      provider.session = undefined;
    });
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
      return Promise.resolve(undefined);
    });
    setWalletConnectProvider(provider);

    await expect(connect({ fresh: true })).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    expect(provider.disconnect).toHaveBeenCalled();
    expect(provider.connect).toHaveBeenCalled();
  });

  it("still pairs when dropping the stored session fails", async () => {
    const provider = fakeProvider({ accounts: [OTHER] });
    provider.disconnect = vi.fn(async () => {
      provider.session = undefined;
      throw new Error("relay gone");
    });
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
      return Promise.resolve(undefined);
    });
    setWalletConnectProvider(provider);

    await expect(connect({ fresh: true })).resolves.toEqual({ address: ADDR, wallet: "freighter" });
  });

  it("does not wait on a relay that never confirms the drop", async () => {
    vi.useFakeTimers();
    const provider = fakeProvider({ accounts: [OTHER] });
    // The SDK only clears its session after the relay answers the disconnect.
    provider.disconnect = vi.fn(() => new Promise<never>(() => {}));
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
      return Promise.resolve(undefined);
    });
    setWalletConnectProvider(provider);

    const attempt = expect(connect({ fresh: true })).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    await vi.advanceTimersByTimeAsync(DROP_SESSION_WAIT_MS);
    await attempt;
    vi.useRealTimers();
  });

  it("reuses a stored session when not asked for a fresh one", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    setWalletConnectProvider(provider);

    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(provider.connect).not.toHaveBeenCalled();
  });
});

describe("signing — a request the wallet never answers", () => {
  /** A provider with a session whose requests Freighter never answers. */
  function unansweredProvider(): WalletConnectProvider & { request: ReturnType<typeof vi.fn> } {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockImplementation(() => new Promise<never>(() => {}));
    provider.disconnect = vi.fn(async () => {
      provider.session = undefined;
    });
    return provider;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a signature with timed_out and drops the session", async () => {
    vi.useFakeTimers();
    const provider = unansweredProvider();
    setWalletConnectProvider(provider);

    const attempt = expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "timed_out" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await attempt;
    // The next attempt must pair afresh rather than talk to the same dead session.
    expect(provider.disconnect).toHaveBeenCalled();
  });

  it("gives up on a transaction signature the same way", async () => {
    vi.useFakeTimers();
    const provider = unansweredProvider();
    setWalletConnectProvider(provider);

    const attempt = expect(signTransaction("AAAA", ADDR)).rejects.toMatchObject({ code: "timed_out" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await attempt;
    expect(provider.disconnect).toHaveBeenCalled();
  });

  it("stops at once with cancelled when the contributor cancels, and drops the session", async () => {
    const provider = unansweredProvider();
    setWalletConnectProvider(provider);

    const attempt = signOwnership(MESSAGE, ADDR);
    await vi.waitFor(() => expect(provider.request).toHaveBeenCalled());
    cancelWalletRequest();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
    expect(provider.disconnect).toHaveBeenCalled();
  });

  it("reports a cancel promptly even when the relay never confirms the drop", async () => {
    vi.useFakeTimers();
    const provider = unansweredProvider();
    provider.disconnect = vi.fn(() => new Promise<never>(() => {}));
    setWalletConnectProvider(provider);

    const attempt = signOwnership(MESSAGE, ADDR);
    attempt.catch(() => {});
    await vi.waitFor(() => expect(provider.request).toHaveBeenCalled());
    cancelWalletRequest();
    await vi.advanceTimersByTimeAsync(DROP_SESSION_WAIT_MS);
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
    // Forgotten here even so, so the retry pairs afresh.
    expect(provider.session).toBeUndefined();
  });

  it("cancels a pairing too, so one Cancel covers the whole wait", async () => {
    const provider = fakeProvider();
    provider.connect = vi.fn(() => new Promise<never>(() => {}));
    setWalletConnectProvider(provider);

    const attempt = connect();
    await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
    cancelWalletRequest();
    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
  });

  it("does nothing when nothing is pending", () => {
    expect(() => cancelWalletRequest()).not.toThrow();
  });
});

describe("signing — with no session", () => {
  it("pairs first instead of failing, then signs", async () => {
    const signature = sep53Sign(MESSAGE);
    const provider = fakeProvider();
    provider.connect = vi.fn().mockImplementation(() => {
      provider.session = { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } };
      return Promise.resolve(undefined);
    });
    provider.request.mockResolvedValue({ signature });
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).resolves.toMatchObject({ address: ADDR, signature });
    expect(provider.connect).toHaveBeenCalled();
  });
});

describe("signOwnership", () => {
  it("requests stellar_signMessage on the active chain and returns a SEP-53 proof", async () => {
    const signature = sep53Sign(MESSAGE);
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({ signature });
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).resolves.toEqual({
      address: ADDR,
      signature,
      scheme: "sep53",
      wallet: "freighter",
    });
    expect(provider.request).toHaveBeenCalledWith(
      { method: "stellar_signMessage", params: { message: MESSAGE } },
      CHAIN,
    );
  });

  it("rejects a signature that isn't from the expected address", async () => {
    // The mobile wallet sends back no `signerAddress`, so a signature from the
    // wrong account is only catchable by verifying it — which is the point.
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({ signature: sep53Sign(MESSAGE, Keypair.random()) });
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "wrong_account" });
  });

  it("rejects a valid signature over a different message", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({ signature: sep53Sign("some other challenge") });
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "wrong_account" });
  });

  it("refuses before signing when the session is a different account", async () => {
    const provider = fakeProvider({ accounts: [OTHER] });
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "wrong_account" });
    expect(provider.request).not.toHaveBeenCalled();
  });

  it("treats a missing signature as a rejection", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({});
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "rejected" });
  });

  it("maps a declined signing prompt to `rejected`", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockRejectedValue(new Error("User rejected the request"));
    setWalletConnectProvider(provider);

    await expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "rejected" });
  });
});

describe("signTransaction", () => {
  /** A real envelope signed by `signers`, as the wallet would return it. */
  function signedEnvelope(signers: Keypair[]): string {
    const {
      Account,
      Asset,
      Networks,
      Operation,
      TransactionBuilder,
    } = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
    const tx = new TransactionBuilder(new Account(ADDR, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", OTHER) }))
      .setTimeout(120)
      .build();
    for (const signer of signers) tx.sign(signer);
    return tx.toXDR();
  }

  it("requests stellar_signXDR and returns the co-signed envelope", async () => {
    const xdr = signedEnvelope([kp]);
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({ signedXDR: xdr });
    setWalletConnectProvider(provider);

    await expect(signTransaction("unsigned-xdr", ADDR)).resolves.toBe(xdr);
    expect(provider.request).toHaveBeenCalledWith(
      { method: "stellar_signXDR", params: { xdr: "unsigned-xdr" } },
      CHAIN,
    );
  });

  it("rejects an envelope carrying no signature from the expected account", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({ signedXDR: signedEnvelope([Keypair.random()]) });
    setWalletConnectProvider(provider);

    await expect(signTransaction("unsigned-xdr", ADDR)).rejects.toMatchObject({
      code: "wrong_account",
    });
  });

  it("reports an unreadable envelope rather than passing it on", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({ signedXDR: "not-xdr" });
    setWalletConnectProvider(provider);

    await expect(signTransaction("unsigned-xdr", ADDR)).rejects.toMatchObject({ code: "failed" });
  });

  it("treats a missing signedXDR as a rejection", async () => {
    const provider = fakeProvider({ accounts: [ADDR] });
    provider.request.mockResolvedValue({});
    setWalletConnectProvider(provider);

    await expect(signTransaction("unsigned-xdr", ADDR)).rejects.toMatchObject({ code: "rejected" });
  });
});

describe("formatNativeUrl", () => {
  const URI = "wc:topic@2?relay-protocol=irn&symKey=abc";

  it("keeps a bare scheme intact and adds WalletConnect's wc entry", () => {
    expect(formatNativeUrl("freighterwallet://", URI)).toBe(
      `freighterwallet://wc?uri=${encodeURIComponent(URI)}`,
    );
  });

  it("preserves a published path rather than rewriting it to /wc", () => {
    // Freighter only pairs from a URL containing the redirect string it was
    // built with, so the registry's path has to survive verbatim.
    expect(formatNativeUrl("freighterwallet://wc-redirect", URI)).toBe(
      `freighterwallet://wc-redirect?uri=${encodeURIComponent(URI)}`,
    );
  });

  it("does not double the wc segment when the link already ends in one", () => {
    expect(formatNativeUrl("freighterwallet://wc", URI)).toBe(
      `freighterwallet://wc?uri=${encodeURIComponent(URI)}`,
    );
  });

  it("handles a universal https link", () => {
    expect(formatNativeUrl("https://freighter.app/", URI)).toBe(
      `https://freighter.app/wc?uri=${encodeURIComponent(URI)}`,
    );
  });

  it("appends to a link that already carries a query", () => {
    expect(formatNativeUrl("https://freighter.app/wc?x=1", URI)).toBe(
      `https://freighter.app/wc?x=1&uri=${encodeURIComponent(URI)}`,
    );
  });

  it("escapes the pairing uri so its own query survives the round trip", () => {
    const link = formatNativeUrl("freighterwallet://wc", URI);
    const encoded = link.split("uri=")[1];
    expect(decodeURIComponent(encoded)).toBe(URI);
  });
});

describe("isFreighterInAppBrowser", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("is false when nothing is injected", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(isFreighterInAppBrowser()).toBe(false);
  });

  it("recognizes the marker Freighter mobile injects into its own browser", () => {
    (globalThis as { window?: unknown }).window = {
      stellar: { provider: "freighter", platform: "mobile", version: "1.0.0" },
    };
    expect(isFreighterInAppBrowser()).toBe(true);
  });

  it("ignores another wallet's injected object", () => {
    (globalThis as { window?: unknown }).window = {
      stellar: { provider: "somethingelse", platform: "mobile" },
    };
    expect(isFreighterInAppBrowser()).toBe(false);
  });
});
