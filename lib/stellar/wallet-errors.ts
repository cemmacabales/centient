// The wallet vocabulary shared by both transports — the Freighter browser
// extension (wallet-extension.ts) and Freighter mobile over WalletConnect
// (wallet-connect.ts) — plus the facade in wallet.ts that picks between them.
//
// It lives in its own module so the two transports can both raise the same
// errors without importing each other, and so wallet.ts can dynamically
// `import()` a transport without dragging its SDK in just to name an error.
// Everything here is re-exported from wallet.ts, which stays the import site
// for the rest of the app.

/** Which signing scheme produced a signature — selects the server verify path. */
export type SignatureScheme = "sep53";

/** Which Freighter a connection/signature came from. */
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

/**
 * Shown when an action needs Freighter and neither transport can reach one:
 * no extension, and no Freighter mobile to pair with.
 */
export const FREIGHTER_REQUIRED_MESSAGE =
  "Freighter is required. Install the Freighter browser extension, or connect the Freighter mobile app, then try again.";

/**
 * Why a wallet call failed, so a caller can pick a state instead of parsing
 * `message`:
 *
 *   • `freighter_missing`         — no extension, and no mobile path available.
 *   • `rejected`                  — the user declined access or signing.
 *   • `wrong_account`             — Freighter signed with a different account.
 *   • `wrong_network`             — the wallet is on a different Stellar network.
 *   • `unsupported`               — this Freighter build cannot sign messages.
 *   • `invalid_address`           — the wallet returned something that is not a G… key.
 *   • `walletconnect_unconfigured`— this deployment has no WalletConnect project id.
 *   • `failed`                    — any other wallet error.
 */
export type WalletErrorCode =
  | "freighter_missing"
  | "rejected"
  | "wrong_account"
  | "wrong_network"
  | "unsupported"
  | "invalid_address"
  | "walletconnect_unconfigured"
  | "failed";

/** Thrown by every wallet call; `message` stays human-readable. */
export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Guard a wallet-returned address: reject non-StrKey / corrupted input. */
export function assertAddress(
  address: string | undefined,
  isValid: (s: string) => boolean,
): asserts address is string {
  if (!address || !isValid(address)) {
    throw new WalletError(
      "invalid_address",
      `Wallet returned an invalid Stellar address: ${address}`,
    );
  }
}
