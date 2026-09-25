// Which Freighter a browser ends up talking to. The rule is small but it is
// what keeps a phone off the "install the browser extension" dead end, so it
// gets its own suite: extension when one answers, the mobile app otherwise,
// and the old refusal only when neither is reachable.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

const { mockIsConnected, mockRequestAccess, mockSignMessage, mockExtSignTransaction } = vi.hoisted(
  () => ({
    mockIsConnected: vi.fn(),
    mockRequestAccess: vi.fn(),
    mockSignMessage: vi.fn(),
    mockExtSignTransaction: vi.fn(),
  }),
);

vi.mock("@stellar/freighter-api", () => ({
  isConnected: mockIsConnected,
  requestAccess: mockRequestAccess,
  signMessage: mockSignMessage,
  signTransaction: mockExtSignTransaction,
}));

import {
  connect,
  isFreighterAvailable,
  prepareWallet,
  resetTransport,
  resolveTransport,
  signOwnership,
  signTransaction,
} from "@/lib/stellar/wallet";
import {
  resetMobileLinkCache,
  setWalletConnectProvider,
  type WalletConnectProvider,
} from "@/lib/stellar/wallet-connect";

const ADDR = Keypair.random().publicKey();
const CHAIN = "stellar:testnet";

/** A paired mobile session for ADDR, so the WalletConnect path can be reached. */
function mobileProvider(): WalletConnectProvider & { request: ReturnType<typeof vi.fn> } {
  return {
    session: { namespaces: { stellar: { accounts: [`${CHAIN}:${ADDR}`] } } },
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as WalletConnectProvider & { request: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The transport is memoized for the life of the page (a 2s extension probe is
  // not worth repeating); each test is a fresh page.
  resetTransport();
  process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
});

afterEach(() => {
  setWalletConnectProvider(null);
  resetMobileLinkCache();
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
});

describe("resolveTransport", () => {
  it("prefers the extension when one answers", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: true });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";

    await expect(resolveTransport()).resolves.toBe("extension");
  });

  it("falls back to the mobile app when there is no extension", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";

    await expect(resolveTransport()).resolves.toBe("walletconnect");
  });

  it("falls back to the mobile app when freighter-api throws (no extension at all)", async () => {
    mockIsConnected.mockRejectedValue(new Error("no extension"));
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";

    await expect(resolveTransport()).resolves.toBe("walletconnect");
  });

  it("resolves to nothing when neither is reachable", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });

    await expect(resolveTransport()).resolves.toBeNull();
    await expect(isFreighterAvailable()).resolves.toBe(false);
  });

  it("reports a wallet as available on either transport", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";

    await expect(isFreighterAvailable()).resolves.toBe(true);
  });
});

describe("memoization", () => {
  // `@stellar/freighter-api` waits a hard-coded 2s before reporting "no
  // extension", so probing per call would cost seconds of dead time on a phone.
  it("probes for the extension once, however many wallet calls follow", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
    setWalletConnectProvider(mobileProvider());

    await resolveTransport();
    await resolveTransport();
    await connect();
    await isFreighterAvailable();

    expect(mockIsConnected).toHaveBeenCalledTimes(1);
  });

  it("shares one probe between callers that race", async () => {
    let release: (v: { isConnected: boolean }) => void = () => {};
    mockIsConnected.mockReturnValue(
      new Promise<{ isConnected: boolean }>((resolve) => {
        release = resolve;
      }),
    );

    const both = Promise.all([resolveTransport(), resolveTransport()]);
    release({ isConnected: true });

    expect(await both).toEqual(["extension", "extension"]);
    expect(mockIsConnected).toHaveBeenCalledTimes(1);
  });

  it("probes again after a reset", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: true });
    await resolveTransport();
    resetTransport();
    await resolveTransport();

    expect(mockIsConnected).toHaveBeenCalledTimes(2);
  });
});

describe("prepareWallet", () => {
  it("looks the deep link up ahead of the tap, not after it", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
    setWalletConnectProvider(mobileProvider());
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ listings: {} })));

    await expect(prepareWallet()).resolves.toBe("walletconnect");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0][0])).toContain("explorer-api.walletconnect.com");

    fetchSpy.mockRestore();
  });

  it("leaves the extension path alone — no relay, no registry call", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: true });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(prepareWallet()).resolves.toBe("extension");
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("resolves to null when no wallet is reachable, without throwing", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });

    await expect(prepareWallet()).resolves.toBeNull();
  });
});

describe("dispatch", () => {
  it("routes connect to the extension when it is present", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: true });
    mockRequestAccess.mockResolvedValue({ address: ADDR });

    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    expect(mockRequestAccess).toHaveBeenCalled();
  });

  it("routes connect to the mobile app when the extension is absent", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
    setWalletConnectProvider(mobileProvider());

    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
    expect(mockRequestAccess).not.toHaveBeenCalled();
  });

  it("still refuses with freighter_missing when nothing is reachable", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });

    await expect(connect()).rejects.toMatchObject({ code: "freighter_missing" });
    await expect(signOwnership("challenge", ADDR)).rejects.toMatchObject({
      code: "freighter_missing",
    });
    await expect(signTransaction("xdr", ADDR)).rejects.toMatchObject({
      code: "freighter_missing",
    });
  });
});
