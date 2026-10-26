// Lantern's postMessage bridge (wallet-lantern.ts), against a stand-in for the
// framing Lantern window. Replies are the shapes Lantern 0.5.1 posts, plus
// `lantern:signXdr` from 0.6.0.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { lanternMessageBytes } from "@/lib/stellar/signature";
import {
  ACK_TIMEOUT_MS,
  cancelLanternRequest,
  connect,
  signOwnership,
  signTransaction,
} from "@/lib/stellar/wallet-lantern";
import { WalletError } from "@/lib/stellar/wallet-errors";

const LANTERN = "https://android.golantern.xyz";
const kp = Keypair.random();
const ADDR = kp.publicKey();

type Posted = Record<string, unknown>;

let parent: { postMessage: ReturnType<typeof vi.fn> };
let win: EventTarget & { location: unknown };

/** Lantern posting `data` to this page, from `origin` and `source`. */
function reply(data: Posted, { origin = LANTERN, source = parent as unknown }: { origin?: string; source?: unknown } = {}) {
  const event = new Event("message");
  Object.assign(event, { data, origin, source });
  win.dispatchEvent(event);
}

/** Answer each request Lantern receives with `answer(request)`'s replies. */
function lanternAnswers(answer: (request: Posted) => Posted[]) {
  parent.postMessage.mockImplementation((request: Posted) => {
    queueMicrotask(() => answer(request).forEach((r) => reply(r)));
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_LANTERN_ORIGINS = LANTERN;
  process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
  parent = { postMessage: vi.fn() };
  win = Object.assign(new EventTarget(), {
    self: {},
    top: {},
    parent,
    location: { ancestorOrigins: [LANTERN] },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { referrer: "" });
});

afterEach(() => {
  cancelLanternRequest();
  delete process.env.NEXT_PUBLIC_LANTERN_ORIGINS;
  delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("connect", () => {
  it("asks Lantern for its key, at Lantern's origin only, and returns the address", async () => {
    lanternAnswers(() => [{ type: "lantern:connecting" }, { type: "lantern:publicKey", publicKey: ADDR, network: "TESTNET" }]);

    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "lantern" });
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "lantern:getPublicKey" }, LANTERN);
  });

  it("refuses a wallet on the other network", async () => {
    lanternAnswers(() => [{ type: "lantern:publicKey", publicKey: ADDR, network: "PUBLIC" }]);
    await expect(connect()).rejects.toMatchObject({ code: "wrong_network" });
  });

  it("reads a bare refusal as the contributor declining", async () => {
    lanternAnswers(() => [{ type: "lantern:connectRejected" }]);
    await expect(connect()).rejects.toMatchObject({ code: "rejected" });
  });

  it("ignores look-alike replies from another origin or another window", async () => {
    parent.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        const forged = { type: "lantern:publicKey", publicKey: Keypair.random().publicKey(), network: "TESTNET" };
        reply(forged, { origin: "https://evil.example" });
        reply(forged, { source: {} });
        reply({ type: "lantern:publicKey", publicKey: ADDR, network: "TESTNET" });
      });
    });
    await expect(connect()).resolves.toEqual({ address: ADDR, wallet: "lantern" });
  });

  it("refuses to post anywhere when the page isn't framed by Lantern", async () => {
    win.location = { ancestorOrigins: ["https://evil.example"] };
    await expect(connect()).rejects.toMatchObject({ code: "freighter_missing" });
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("rejects with cancelled when the contributor cancels the wait", async () => {
    const pending = connect();
    cancelLanternRequest();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("signOwnership", () => {
  const MESSAGE = "centient.work wants you to sign in\nNonce: abc";
  const lanternSign = (k: Keypair, m: string) => k.sign(lanternMessageBytes(m)).toString("base64");

  it("returns a lantern-scheme proof that verifies against the address", async () => {
    lanternAnswers((req) => [
      { type: "lantern:messageSigned", signature: lanternSign(kp, String(req.message)), publicKey: ADDR },
    ]);

    await expect(signOwnership(MESSAGE, ADDR)).resolves.toEqual({
      address: ADDR,
      signature: lanternSign(kp, MESSAGE),
      scheme: "lantern",
      wallet: "lantern",
    });
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "lantern:signMessage", message: MESSAGE }, LANTERN);
  });

  it("refuses a signature from another key, whatever Lantern says signed it", async () => {
    const other = Keypair.random();
    lanternAnswers((req) => [
      { type: "lantern:messageSigned", signature: lanternSign(other, String(req.message)), publicKey: ADDR },
    ]);
    await expect(signOwnership(MESSAGE, ADDR)).rejects.toMatchObject({ code: "wrong_account" });
  });

  it("surfaces Lantern's own reason as a failure, not a decline", async () => {
    lanternAnswers(() => [{ type: "lantern:signRejected", error: "Wallet is locked." }]);
    const err = await signOwnership(MESSAGE, ADDR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect(err).toMatchObject({ code: "failed", message: "Lantern: Wallet is locked." });
  });
});

describe("signTransaction (lantern:signXdr)", () => {
  function envelope(): string {
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", Keypair.random().publicKey()), source: ADDR }))
      .setTimeout(300)
      .build();
    return tx.toXDR();
  }

  it("sends the envelope with the network passphrase and returns Lantern's co-signed XDR", async () => {
    const xdr = envelope();
    lanternAnswers((req) => {
      const tx = TransactionBuilder.fromXDR(String(req.xdr), String(req.networkPassphrase));
      tx.sign(kp);
      return [{ type: "lantern:signing" }, { type: "lantern:xdrSigned", signedXdr: tx.toXDR() }];
    });

    const signed = await signTransaction(xdr, ADDR);
    expect(TransactionBuilder.fromXDR(signed, Networks.TESTNET).signatures).toHaveLength(1);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: "lantern:signXdr", xdr, networkPassphrase: Networks.TESTNET },
      LANTERN,
    );
  });

  it("refuses an envelope signed by another key", async () => {
    lanternAnswers((req) => {
      const tx = TransactionBuilder.fromXDR(String(req.xdr), Networks.TESTNET);
      tx.sign(Keypair.random());
      return [{ type: "lantern:signing" }, { type: "lantern:xdrSigned", signedXdr: tx.toXDR() }];
    });
    await expect(signTransaction(envelope(), ADDR)).rejects.toMatchObject({ code: "wrong_account" });
  });

  it("reports a Lantern that never acknowledges (0.5.1) as unsupported, quickly", async () => {
    vi.useFakeTimers();
    const pending = signTransaction(envelope(), ADDR).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(await pending).toMatchObject({ code: "unsupported" });
  });

  it("keeps waiting past the acknowledgement deadline once Lantern has acknowledged", async () => {
    vi.useFakeTimers();
    parent.postMessage.mockImplementation(() => queueMicrotask(() => reply({ type: "lantern:signing" })));
    let settled = false;
    const pending = signTransaction(envelope(), ADDR).finally(() => (settled = true));
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4);
    expect(settled).toBe(false);
    cancelLanternRequest();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});
