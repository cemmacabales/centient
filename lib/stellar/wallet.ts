// Client-side Stellar wallet identity: connect Freighter and prove control of a
// `G…` address. Contributors sign in with it (#26, over #25's
// /api/auth/wallet/*), and the withdrawal screen uses it to prove a payout
// address (ST-4a #299). The server verifies what is produced here in
// lib/stellar/signature.ts.
//
// Freighter is the only supported wallet. Albedo was descoped from Deliverable 2
// (ADR-0003): it was only ever wired as a connect-only fallback, so a user who
// connected with it could never sign the ownership proof or the sponsored
// trustline this module exists to produce.
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
// The wallet SDK is loaded with dynamic `import()` inside each call so this module
// is import-safe under SSR (no `window` access at module load) and the wallet
// bundle stays out of the server build.
import { isValidStellarAddress } from "./signature";
import { networkPassphrase } from "./config";

/** Which signing scheme produced a signature — selects the server verify path. */
export type SignatureScheme = "sep53";

/** Which browser wallet a connection/signature came from. */
export type StellarWallet = "freighter";

/** A connected wallet address plus the wallet it came from. */
export interface StellarConnection {
  address: string; // G… (case-sensitive — never normalized)
  wallet: StellarWallet;
}

/** A normalized ownership proof ready to POST to the server for verification. */
export interface StellarSignedMessage {
  address: string; // G… signer
  signature: string; // base64-encoded ed25519 signature
  scheme: SignatureScheme;
  wallet: StellarWallet;
}

/** Shown whenever an action needs Freighter and the extension is not reachable. */
export const FREIGHTER_REQUIRED_MESSAGE =
  "Freighter is required. Install the Freighter browser extension, then try again.";

/** Freighter's `FreighterApiError.code` when the user declines a prompt. */
const FREIGHTER_USER_REJECTED = -4;

/**
 * Why a wallet call failed, so a caller can pick a state instead of parsing
 * `message`:
 *
 *   • `freighter_missing` — the extension is not installed or not reachable.
 *   • `rejected`          — the user declined access or signing.
 *   • `wrong_account`     — Freighter signed with a different account.
 *   • `unsupported`       — this Freighter build cannot sign messages.
 *   • `invalid_address`   — the wallet returned something that is not a G… key.
 *   • `failed`            — any other wallet error.
 */
export type WalletErrorCode =
  | "freighter_missing"
  | "rejected"
  | "wrong_account"
  | "unsupported"
  | "invalid_address"
  | "failed";

/** Thrown by every call in this module; `message` stays human-readable. */
export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

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
    networkPassphrase: networkPassphrase(),
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
  if (!address || !isValidStellarAddress(address)) {
    throw new WalletError("invalid_address", `Wallet returned an invalid Stellar address: ${address}`);
  }
}
