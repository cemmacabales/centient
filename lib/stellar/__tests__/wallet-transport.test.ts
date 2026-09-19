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
  resolveTransport,
  signOwnership,
  signTransaction,
} from "@/lib/stellar/wallet";
import { setWalletConnectProvider, type WalletConnectProvider } from "@/lib/stellar/wallet-connect";

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
  process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
});

afterEach(() => {
  setWalletConnectProvider(null);
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
