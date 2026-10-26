// Lantern — the transport wallet.ts uses when this page is running inside
// Lantern's Apps tab (see lantern.ts for how that is decided).
//
// Lantern doesn't inject a provider or speak WalletConnect. It frames the dApp
// and answers `postMessage` requests from it, a protocol read off its own
// bundle (`Apps-*.js`, v0.5.1):
//
//   dApp → Lantern              Lantern → dApp
//   lantern:getPublicKey        lantern:connecting, then
//                               lantern:publicKey { publicKey, network } | lantern:connectRejected
//   lantern:signMessage         lantern:messageSigned { signature, publicKey }
//     { message }               | lantern:signRejected { error? }
//   lantern:signXdr  (0.6.0+)   lantern:signing, then
//     { xdr, networkPassphrase } lantern:xdrSigned { signedXdr }
//                               | lantern:signRejected { error? } | lantern:txError { error }
//
// `network` is Lantern's network id, "TESTNET" or "PUBLIC": the same networks as
// clientStellarNetwork()'s "testnet" and "public", in Lantern's case.
// `signMessage` signs `"Lantern signed message:\n" + message` unhashed, not
// SEP-53, so proofs from here carry `scheme: "lantern"` and the server verifies
// them that way (signature.ts).
//
// `lantern:signXdr` arrived in 0.6.0. 0.5.1 only offers `signAndSubmit`, which
// takes a payment *intent* and builds the transaction itself, so it can't add
// the recipient's half to payout setup's sponsored envelope. On 0.5.x a request
// goes unanswered, so it must be acknowledged within {@link ACK_TIMEOUT_MS} or
// it is reported as unsupported rather than left hanging for minutes.
//
// Replies carry no request id, so one request runs at a time; starting another
// cancels the one in flight.
import { isValidStellarAddress, verify } from "./signature";
import { clientNetworkPassphrase, clientStellarNetwork } from "./config";
import { lanternOrigins, parentOrigin } from "./lantern";
import { WalletError, type StellarSignedMessage } from "./wallet-errors";

/** How long Lantern has to answer a prompt the contributor has to act on. */
export const REQUEST_TIMEOUT_MS = 3 * 60_000;

/** How long Lantern has to acknowledge a `signXdr` before it counts as unsupported. */
export const ACK_TIMEOUT_MS = 5_000;

type LanternReply = { type?: unknown } & Record<string, unknown>;

/**
 * Settle a request from a reply: return a value to resolve with, throw a
 * {@link WalletError} to reject, or return `undefined` to keep waiting.
 */
type ReplyHandler<T> = (reply: LanternReply) => T | undefined;

interface Pending {
  reject: (err: WalletError) => void;
}

let pending: Pending | null = null;

/** Stop waiting on Lantern; the request in flight rejects with `cancelled`. */
export function cancelLanternRequest(): void {
  pending?.reject(new WalletError("cancelled", "You cancelled the request."));
}

/**
 * Post `message` to Lantern and wait for a reply `handle` settles on. Only
 * messages from the framing window, at a Lantern origin, are read: Lantern posts
 * to `*`, so the check is ours to make.
 */
function request<T>(
  message: Record<string, unknown>,
  handle: ReplyHandler<T>,
  options: { ackType?: string } = {},
): Promise<T> {
  const target = parentOrigin();
  if (typeof window === "undefined" || !target || !lanternOrigins().includes(target)) {
    return Promise.reject(new WalletError("freighter_missing", "Centient isn't open inside Lantern."));
  }
  cancelLanternRequest();

  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const self: Pending = { reject: (err) => settle(() => reject(err)) };

    function settle(finish: () => void) {
      if (pending !== self) return;
      pending = null;
      clearTimeout(timer);
      clearTimeout(ackTimer);
      window.removeEventListener("message", onMessage);
      finish();
    }

    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent || !lanternOrigins().includes(event.origin)) return;
      const reply = event.data as LanternReply;
      if (!reply || typeof reply.type !== "string" || !reply.type.startsWith("lantern:")) return;
      if (options.ackType && reply.type === options.ackType) {
        clearTimeout(ackTimer);
        return;
      }
      try {
        const value = handle(reply);
        if (value !== undefined) settle(() => resolve(value));
      } catch (err) {
        settle(() => reject(err));
      }
    }

    pending = self;
    window.addEventListener("message", onMessage);
    timer = setTimeout(
      () => self.reject(new WalletError("timed_out", "Lantern didn't answer in time. Try again.")),
      REQUEST_TIMEOUT_MS,
    );
    if (options.ackType) {
      ackTimer = setTimeout(
        () =>
          self.reject(
            new WalletError("unsupported", "This version of Lantern can't sign this yet. Update Lantern, then try again."),
          ),
        ACK_TIMEOUT_MS,
      );
    }
    window.parent.postMessage(message, target);
  });
}

/** A refusal from Lantern: a bare one is the contributor saying no. */
function refusal(reply: LanternReply): WalletError {
  const error = typeof reply.error === "string" ? reply.error : "";
  return error
    ? new WalletError("failed", `Lantern: ${error}`)
    : new WalletError("rejected", "You declined the request in Lantern.");
}

/** Connect Lantern and return its `G…` address, prompting the contributor. */
export async function connect(): Promise<{ address: string; wallet: "lantern" }> {
  return request({ type: "lantern:getPublicKey" }, (reply) => {
    if (reply.type === "lantern:connectRejected") throw refusal(reply);
    if (reply.type !== "lantern:publicKey") return undefined;
    const address = typeof reply.publicKey === "string" ? reply.publicKey : "";
    if (!isValidStellarAddress(address)) {
      throw new WalletError("invalid_address", `Wallet returned an invalid Stellar address: ${address}`);
    }
    const network = clientStellarNetwork();
    if (String(reply.network).toLowerCase() !== network) {
      throw new WalletError(
        "wrong_network",
        `Lantern is on ${String(reply.network)}, not ${network}. Switch the network in Lantern, then try again.`,
      );
    }
    return { address, wallet: "lantern" as const };
  });
}

/**
 * Prove ownership of `expectedAddress` with Lantern's message signature. Lantern
 * reports the signing key, but the signature is checked against the address we
 * expect anyway, as on the WalletConnect path: a real check, not a self-report.
 */
export async function signOwnership(
  message: string,
  expectedAddress: string,
): Promise<StellarSignedMessage> {
  const signature = await request({ type: "lantern:signMessage", message }, (reply) => {
    if (reply.type === "lantern:signRejected") throw refusal(reply);
    if (reply.type !== "lantern:messageSigned") return undefined;
    return typeof reply.signature === "string" ? reply.signature : "";
  });
  if (!signature) {
    throw new WalletError("rejected", "Lantern returned no signature (signing was rejected).");
  }
  if (!verify(expectedAddress, message, signature, "lantern")) {
    throw new WalletError(
      "wrong_account",
      `That signature isn't from ${expectedAddress}. Switch to the account you connected, then try again.`,
    );
  }
  return { address: expectedAddress, signature, scheme: "lantern", wallet: "lantern" };
}

/**
 * Co-sign a server-built envelope with Lantern, for payout setup's sponsored
 * trustline. Needs `lantern:signXdr` (Lantern 0.6.0+); see the header.
 */
export async function signTransaction(xdr: string, expectedAddress: string): Promise<string> {
  const signedXdr = await request(
    { type: "lantern:signXdr", xdr, networkPassphrase: clientNetworkPassphrase() },
    (reply) => {
      if (reply.type === "lantern:signRejected" || reply.type === "lantern:txError") throw refusal(reply);
      if (reply.type !== "lantern:xdrSigned") return undefined;
      return typeof reply.signedXdr === "string" ? reply.signedXdr : "";
    },
    { ackType: "lantern:signing" },
  );
  if (!signedXdr) {
    throw new WalletError("rejected", "Lantern returned no signature (signing was rejected).");
  }
  await assertSignedBy(signedXdr, expectedAddress);
  return signedXdr;
}

/** Throw `wrong_account` unless `signedXdr` carries a valid signature from `expectedAddress`. */
async function assertSignedBy(signedXdr: string, expectedAddress: string): Promise<void> {
  const { Keypair, TransactionBuilder } = await import("@stellar/stellar-sdk");
  let signedBy = false;
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, clientNetworkPassphrase());
    const keypair = Keypair.fromPublicKey(expectedAddress);
    const hash = tx.hash();
    signedBy = tx.signatures.some((sig) => keypair.verify(hash, sig.signature()));
  } catch (err) {
    throw new WalletError(
      "failed",
      `Lantern returned a transaction we couldn't read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!signedBy) {
    throw new WalletError(
      "wrong_account",
      `Lantern signed with a different account: the envelope carries no signature from ${expectedAddress}.`,
    );
  }
}
