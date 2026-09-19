// The Freighter **browser extension** transport — the desktop path, and what
// this app spoke exclusively before Freighter mobile was supported. Lifted out
// of wallet.ts unchanged when wallet-connect.ts joined it; wallet.ts now picks
// between the two and re-exports the same API.
//
//   • Freighter (`@stellar/freighter-api`) signs per **SEP-53** and returns a
//     base64 ed25519 signature (newer "V4") or a Buffer ("V3", older). Its
//     `signMessage` return shape changed across versions:
//         V3: { signedMessage: Buffer | null,  signerAddress, error? }
//         V4: { signedMessage: string | null,  signerAddress, error? }   // base64
//     `freighterSignatureToBase64` normalizes both to base64. signerAddress is
//     the G… signer.
//
// SEP-10 fallback (issue note): SEP-53 message signing proved consistent for
// Freighter (confirmed shape above), so we did NOT need the SEP-10
// challenge-transaction fallback. Revisit only if a target wallet lacks
// SEP-53 `signMessage`.
//
// The wallet SDK is loaded with dynamic `import()` inside each call so this
// module is import-safe under SSR (no `window` access at module load) and the
// wallet bundle stays out of the server build.
import { isValidStellarAddress } from "./signature";
import { clientNetworkPassphrase } from "./config";
import {
  FREIGHTER_REQUIRED_MESSAGE,
  WalletError,
  assertAddress as assertValidAddress,
  type StellarConnection,
  type StellarSignedMessage,
} from "./wallet-errors";

/** Freighter's `FreighterApiError.code` when the user declines a prompt. */
const FREIGHTER_USER_REJECTED = -4;

/** Map a Freighter API error to a {@link WalletError}. */
function freighterError(
  error: { code?: number; message: string },
  prefix: string,
): WalletError {
  const code = error.code === FREIGHTER_USER_REJECTED ? "rejected" : "failed";
  return new WalletError(code, `${prefix}: ${error.message}`);
}

/**
 * Normalize a Freighter `signMessage` `signedMessage` to a base64 string.
 * Accepts the V4 base64 string as-is and encodes the V3 Buffer/Uint8Array.
 * Throws on `null` — Freighter returns null when the user rejects signing.
 */
export function freighterSignatureToBase64(
  signedMessage: string | ArrayBufferView | null | undefined,
): string {
  if (signedMessage == null) {
    throw new Error("Freighter returned no signature (signing was rejected).");
  }
  if (typeof signedMessage === "string") return signedMessage; // V4: already base64
  // V3: raw signature bytes.
  const view = signedMessage as ArrayBufferView;
  return Buffer.from(
    view.buffer,
    view.byteOffset,
    view.byteLength,
  ).toString("base64");
}

/** True if the Freighter extension is installed and reachable. */
export async function isFreighterAvailable(): Promise<boolean> {
  try {
    const { isConnected } = await import("@stellar/freighter-api");
    const res = await isConnected();
    return Boolean(res?.isConnected);
  } catch {
    return false;
  }
}

/**
 * Connect Freighter and return its `G…` address, prompting for access. Throws
 * {@link FREIGHTER_REQUIRED_MESSAGE} when the extension is not reachable.
 */
export async function connect(): Promise<StellarConnection> {
  if (!(await isFreighterAvailable())) {
    throw new WalletError("freighter_missing", FREIGHTER_REQUIRED_MESSAGE);
  }

  const { requestAccess } = await import("@stellar/freighter-api");
  const { address, error } = await requestAccess();
  if (error) throw freighterError(error, "Freighter access denied");
  assertAddress(address);
  return { address, wallet: "freighter" };
}

/**
 * Prove ownership of `expectedAddress` by signing `message` with Freighter
 * (SEP-53), producing a signature the server verifies in signature.ts.
 *
 * @param message         The server-issued challenge string to sign.
 * @param expectedAddress The G… address the proof must be bound to — the signer
 *                        must match it exactly (case-sensitive).
 */
export async function signOwnership(
  message: string,
  expectedAddress: string,
): Promise<StellarSignedMessage> {
  assertAddress(expectedAddress);

  if (!(await isFreighterAvailable())) {
    throw new WalletError("freighter_missing", FREIGHTER_REQUIRED_MESSAGE);
  }

  const { signMessage } = await import("@stellar/freighter-api");
  if (typeof signMessage !== "function") {
    throw new WalletError(
      "unsupported",
      "This version of Freighter cannot sign messages. Update Freighter, then try again.",
    );
  }
  const res = await signMessage(message, { address: expectedAddress });
  if (res.error) throw freighterError(res.error, "Freighter signing failed");
  if (res.signedMessage == null) {
    throw new WalletError("rejected", "Freighter returned no signature (signing was rejected).");
  }
  if (res.signerAddress !== expectedAddress) {
    throw new WalletError(
      "wrong_account",
      `Signed with the wrong account: expected ${expectedAddress}, got ${res.signerAddress}.`,
    );
  }
  return {
    address: res.signerAddress,
    signature: freighterSignatureToBase64(res.signedMessage),
    scheme: "sep53",
    wallet: "freighter",
  };
}

/**
 * Co-sign a server-built transaction XDR with Freighter and return the signed
 * XDR. Used for the ST-4e sponsored-trustline flow: the platform has already
 * signed as sponsor; the recipient adds their signature here.
 *
 * @param xdr             The platform-signed transaction envelope (base64 XDR).
 * @param expectedAddress The G… address whose signature is required; the wallet
 *                        signer must match it exactly (case-sensitive).
 */
export async function signTransaction(
  xdr: string,
  expectedAddress: string,
): Promise<string> {
  assertAddress(expectedAddress);

  if (!(await isFreighterAvailable())) {
    throw new WalletError("freighter_missing", FREIGHTER_REQUIRED_MESSAGE);
  }

  const { signTransaction: freighterSign } = await import("@stellar/freighter-api");
  const res = await freighterSign(xdr, {
    address: expectedAddress,
    networkPassphrase: clientNetworkPassphrase(),
  });
  if (res.error) throw freighterError(res.error, "Freighter signing failed");
  if (res.signerAddress !== expectedAddress) {
    throw new WalletError(
      "wrong_account",
      `Signed with the wrong account: expected ${expectedAddress}, got ${res.signerAddress}.`,
    );
  }
  return res.signedTxXdr;
}

/** Guard a wallet-returned address: reject non-StrKey / corrupted input. */
function assertAddress(address: string | undefined): asserts address is string {
  assertValidAddress(address, isValidStellarAddress);
}
