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
// Freighter comes in two shapes, and this module is the seam between them:
//
//   • the **browser extension** (wallet-extension.ts), over
//     `@stellar/freighter-api` — the desktop path, unchanged;
//   • the **mobile app** (wallet-connect.ts), over WalletConnect v2 — the phone
//     path, and also what a desktop without the extension can pair with by QR.
//
// The extension wins whenever it is reachable, because it needs no pairing and
// no relay. Everything else falls through to WalletConnect when the deployment
// has a project id, so a phone browser and Freighter's own in-app browser — in
// which `@stellar/freighter-api` is just as absent — both land on a path that
// works instead of on "install the browser extension", which no phone can do.
//
// Callers (wallet-sign-in.ts, wallet-claim.ts, payout-setup.ts,
// freighter-proof.ts) import from here and don't know which transport ran.
import {
  isWalletConnectConfigured,
  type WalletConnectPairing,
} from "./wallet-connect";
import {
  isFreighterAvailable as isExtensionAvailable,
  connect as extensionConnect,
  signOwnership as extensionSignOwnership,
  signTransaction as extensionSignTransaction,
} from "./wallet-extension";
import {
  FREIGHTER_REQUIRED_MESSAGE,
  WalletError,
  type StellarConnection,
  type StellarSignedMessage,
} from "./wallet-errors";

export {
  FREIGHTER_REQUIRED_MESSAGE,
  WalletError,
  type SignatureScheme,
  type StellarConnection,
  type StellarSignedMessage,
  type StellarWallet,
  type WalletErrorCode,
} from "./wallet-errors";
export { freighterSignatureToBase64 } from "./wallet-extension";
export {
  isFreighterInAppBrowser,
  isMobileBrowser,
  isWalletConnectConfigured,
  onPairing,
  type WalletConnectPairing,
} from "./wallet-connect";

/** Which Freighter a call will talk to. */
export type WalletTransport = "extension" | "walletconnect";

/**
 * Pick the transport for this browser. The extension is preferred wherever it
 * answers; otherwise the mobile app, when this deployment can offer it.
 *
 * Exported so the UI can word itself before anything is clicked — "Connect
 * Freighter" on a desktop with the extension, "Open the Freighter app" on a
 * phone — rather than finding out only after a failure.
 */
export async function resolveTransport(): Promise<WalletTransport | null> {
  if (await isExtensionAvailable()) return "extension";
  if (isWalletConnectConfigured()) return "walletconnect";
  return null;
}

/** True if any Freighter — extension or mobile app — can be reached from here. */
export async function isFreighterAvailable(): Promise<boolean> {
  return (await resolveTransport()) !== null;
}

/**
 * Load the WalletConnect transport. Kept behind a dynamic `import()` so a
 * desktop session that never leaves the extension path doesn't download the
 * relay SDK, and so a deployment with no project id never touches it at all.
 */
async function walletConnect() {
  return import("./wallet-connect");
}

/** Refuse the same way the extension-only build used to, when nothing is reachable. */
function noFreighter(): WalletError {
  return new WalletError("freighter_missing", FREIGHTER_REQUIRED_MESSAGE);
}

/**
 * Connect Freighter and return its `G…` address, prompting for access.
 *
 * On the mobile path the pairing itself is surfaced through {@link onPairing}:
 * the promise stays pending while the user approves in the app, exactly as it
 * does while they approve an extension prompt.
 */
export async function connect(): Promise<StellarConnection> {
  const transport = await resolveTransport();
  if (transport === "extension") return extensionConnect();
  if (transport === "walletconnect") return (await walletConnect()).connect();
  throw noFreighter();
}

/**
 * Prove ownership of `expectedAddress` by signing `message` (SEP-53), producing
 * a signature the server verifies in signature.ts.
 *
 * @param message         The server-issued challenge string to sign.
 * @param expectedAddress The G… address the proof must be bound to — the signer
 *                        must match it exactly (case-sensitive).
 */
export async function signOwnership(
  message: string,
  expectedAddress: string,
): Promise<StellarSignedMessage> {
  const transport = await resolveTransport();
  if (transport === "extension") return extensionSignOwnership(message, expectedAddress);
  if (transport === "walletconnect") {
    return (await walletConnect()).signOwnership(message, expectedAddress);
  }
  throw noFreighter();
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
  const transport = await resolveTransport();
  if (transport === "extension") return extensionSignTransaction(xdr, expectedAddress);
  if (transport === "walletconnect") {
    return (await walletConnect()).signTransaction(xdr, expectedAddress);
  }
  throw noFreighter();
}

/**
 * Drop a paired mobile session, so the next connect starts clean. A no-op on
 * the extension path, which holds no session of its own. Call it on sign-out.
 */
export async function disconnect(): Promise<void> {
  if (!isWalletConnectConfigured()) return;
  await (await walletConnect()).disconnect();
}

export type { WalletConnectPairing as Pairing };
