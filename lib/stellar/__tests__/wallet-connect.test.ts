// Freighter mobile over WalletConnect. The provider is injected, so these run
// without a relay, a project id or a phone — what is under test is the contract
// this app holds with the wallet: the CAIP chain it asks to sign on, the method
// names and param shapes, and the checks that stand in for the `signerAddress`
// the mobile wallet (unlike the extension) never sends back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";

process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

import {
  connect,
  formatNativeUrl,
  isFreighterInAppBrowser,
  isWalletConnectConfigured,
  onPairing,
  setWalletConnectProvider,
  signOwnership,
  signTransaction,
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
