import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";

process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

const { mockIsConnected, mockSignTransaction, mockRequestAccess, mockSignMessage, freighterState } =
  vi.hoisted(() => ({
    mockIsConnected: vi.fn(),
    mockSignTransaction: vi.fn(),
    mockRequestAccess: vi.fn(),
    mockSignMessage: vi.fn(),
    // Lets one test simulate a Freighter build that has no signMessage.
    freighterState: { signMessageMissing: false },
  }));

vi.mock("@stellar/freighter-api", () => ({
  isConnected: mockIsConnected,
  signTransaction: mockSignTransaction,
  requestAccess: mockRequestAccess,
  get signMessage() {
    return freighterState.signMessageMissing ? undefined : mockSignMessage;
  },
}));

import {
  freighterSignatureToBase64,
  connect,
  signOwnership,
  signTransaction,
  FREIGHTER_REQUIRED_MESSAGE,
  WalletError,
} from "@/lib/stellar/wallet";
import { verify } from "@/lib/stellar/signature";

const kp = Keypair.fromSecret(
  "SDBTJCPJ27TY3BNTANZ3G52FBGCQE76QRP7E2WZQRZLG7GJJBULSQ75E",
);
const MESSAGE = "Link withdrawal address — nonce 12345";

const ADDR = Keypair.random().publicKey();

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConnected.mockResolvedValue({ isConnected: true });
});

function sep53Sign(message: string): Buffer {
  const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
  return kp.sign(hash(Buffer.concat([prefix, Buffer.from(message, "utf8")])));
}

describe("freighterSignatureToBase64", () => {
  it("passes through a V4 base64 string unchanged (canonicalized)", () => {
    const sig = sep53Sign(MESSAGE);
    const b64 = sig.toString("base64");
    expect(freighterSignatureToBase64(b64)).toBe(b64);
  });

  it("encodes a V3 Buffer/Uint8Array to base64", () => {
    const sig = sep53Sign(MESSAGE);
    expect(freighterSignatureToBase64(sig)).toBe(sig.toString("base64"));
    expect(freighterSignatureToBase64(new Uint8Array(sig))).toBe(
      sig.toString("base64"),
    );
  });

  it("throws on a null signedMessage (signing was rejected)", () => {
    expect(() => freighterSignatureToBase64(null)).toThrow();
  });
});

describe("interop with server verify (SEP-53)", () => {
  it("a Freighter V4 base64 signature verifies after normalization", () => {
    const normalized = freighterSignatureToBase64(
      sep53Sign(MESSAGE).toString("base64"),
    );
    expect(verify(kp.publicKey(), MESSAGE, normalized)).toBe(true);
  });

  it("a Freighter V3 Buffer signature verifies after normalization", () => {
    const normalized = freighterSignatureToBase64(sep53Sign(MESSAGE));
    expect(verify(kp.publicKey(), MESSAGE, normalized)).toBe(true);
  });
});

describe("connect", () => {
  it("returns the Freighter address when access is granted", async () => {
    mockRequestAccess.mockResolvedValue({ address: ADDR });
    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "freighter" });
  });

  it("throws install guidance when Freighter is unavailable — there is no fallback wallet", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    await expect(connect()).rejects.toThrow(FREIGHTER_REQUIRED_MESSAGE);
    expect(mockRequestAccess).not.toHaveBeenCalled();
  });
});

describe("signOwnership", () => {
  it("returns a SEP-53 proof that the server verifies", async () => {
    mockSignMessage.mockResolvedValue({
      signedMessage: sep53Sign(MESSAGE).toString("base64"),
      signerAddress: kp.publicKey(),
    });
    const proof = await signOwnership(MESSAGE, kp.publicKey());
    expect(proof).toMatchObject({ scheme: "sep53", wallet: "freighter" });
    expect(verify(kp.publicKey(), MESSAGE, proof.signature)).toBe(true);
  });

  it("throws install guidance when Freighter is unavailable", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    await expect(signOwnership(MESSAGE, ADDR)).rejects.toThrow(FREIGHTER_REQUIRED_MESSAGE);
  });
});

describe("WalletError codes (#26)", () => {
  const REJECTED = { code: -4, message: "The user rejected this request." };

  /** Await a call expected to throw a WalletError and return its code. */
  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WalletError);
    return (err as WalletError).code;
  }

  it("connect: a missing extension is freighter_missing", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    expect(await codeOf(connect())).toBe("freighter_missing");
  });

  it("connect: declining access (-4) is rejected", async () => {
    mockRequestAccess.mockResolvedValue({ address: "", error: REJECTED });
    expect(await codeOf(connect())).toBe("rejected");
  });

  it("connect: any other Freighter error is failed", async () => {
    mockRequestAccess.mockResolvedValue({ address: "", error: { code: -1, message: "locked" } });
    expect(await codeOf(connect())).toBe("failed");
  });

  it("connect: a non-StrKey address is invalid_address", async () => {
    mockRequestAccess.mockResolvedValue({ address: ADDR.toLowerCase() });
    expect(await codeOf(connect())).toBe("invalid_address");
  });

  it("signOwnership: declining the signature (-4) is rejected", async () => {
    mockSignMessage.mockResolvedValue({ signedMessage: null, signerAddress: "", error: REJECTED });
    expect(await codeOf(signOwnership(MESSAGE, ADDR))).toBe("rejected");
  });

  it("signOwnership: a null signature without an error is rejected", async () => {
    mockSignMessage.mockResolvedValue({ signedMessage: null, signerAddress: ADDR });
    expect(await codeOf(signOwnership(MESSAGE, ADDR))).toBe("rejected");
  });

  it("signOwnership: signing with another account is wrong_account", async () => {
    mockSignMessage.mockResolvedValue({
      signedMessage: sep53Sign(MESSAGE).toString("base64"),
      signerAddress: kp.publicKey(),
    });
    expect(await codeOf(signOwnership(MESSAGE, ADDR))).toBe("wrong_account");
  });

  it("signOwnership: a Freighter build without signMessage is unsupported", async () => {
    freighterState.signMessageMissing = true;
    try {
      expect(await codeOf(signOwnership(MESSAGE, ADDR))).toBe("unsupported");
    } finally {
      freighterState.signMessageMissing = false;
    }
  });

  it("signTransaction: declining (-4) is rejected", async () => {
    mockSignTransaction.mockResolvedValue({ signedTxXdr: "", signerAddress: "", error: REJECTED });
    expect(await codeOf(signTransaction("UNSIGNED_XDR", ADDR))).toBe("rejected");
  });

  it("signTransaction: signing with another account is wrong_account", async () => {
    const other = Keypair.random().publicKey();
    mockSignTransaction.mockResolvedValue({ signedTxXdr: "X", signerAddress: other });
    expect(await codeOf(signTransaction("UNSIGNED_XDR", ADDR))).toBe("wrong_account");
  });
});

describe("signTransaction", () => {
  it("returns the Freighter-signed XDR when the signer matches", async () => {
    mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR", signerAddress: ADDR });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).resolves.toBe("SIGNED_XDR");
  });

  it("throws when Freighter signs with the wrong account", async () => {
    const other = Keypair.random().publicKey();
    mockSignTransaction.mockResolvedValue({ signedTxXdr: "X", signerAddress: other });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).rejects.toThrow(/wrong account/);
  });

  it("throws Freighter's error", async () => {
    mockSignTransaction.mockResolvedValue({ error: { message: "user declined" } });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).rejects.toThrow(/user declined/);
  });

  it("throws install guidance when Freighter is unavailable", async () => {
    mockIsConnected.mockResolvedValue({ isConnected: false });
    await expect(signTransaction("UNSIGNED_XDR", ADDR)).rejects.toThrow(FREIGHTER_REQUIRED_MESSAGE);
  });
});
