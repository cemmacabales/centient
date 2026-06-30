// Client-side Stellar wallet identity, used **only at withdrawal** to connect a
// browser wallet and prove ownership of a payout address (ST-4a #299). Login
// stays email/password — this is not a login mechanism. The server verifies what
// is produced here in lib/stellar/signature.ts.
//
// Two wallets are supported, with Freighter primary and Albedo as the fallback
// when Freighter isn't installed:
//
//   • Freighter (`@stellar/freighter-api`) signs per **SEP-53** and returns a
//     base64 ed25519 signature (newer "V4") or a Buffer ("V3", older). Its
//     `signMessage` return shape changed across versions:
//         V3: { signedMessage: Buffer | null,  signerAddress, error? }
//         V4: { signedMessage: string | null,  signerAddress, error? }   // base64
//     `freighterSignatureToBase64` normalizes both to base64. signerAddress is
//     the G… signer.
//
//   • Albedo (`@albedo-link/intent`) does **NOT** use SEP-53 — its `signMessage`
//     signs a proprietary `signed_message` (derived from pubkey + message) and
//     returns a **hex** `message_signature`. So an Albedo signature is NOT
//     verifiable by the SEP-53 `verify()` server-side. We therefore tag every
//     result with its `scheme`; the withdrawal verifier (ST-4b) must branch on
//     it. Until an Albedo verification path exists server-side, Albedo is wired
//     as a **connect-only** fallback and `signOwnership` throws for it rather
//     than returning a signature the server would silently reject.
//
// SEP-10 fallback (issue note): SEP-53 message signing proved consistent for
// Freighter (confirmed shape above), so we did NOT need the SEP-10
// challenge-transaction fallback. Revisit only if a target wallet lacks
// SEP-53 `signMessage`.
//
// Wallet SDKs are loaded with dynamic `import()` inside each call so this module
// is import-safe under SSR (no `window` access at module load) and the wallet
// bundles stay out of the server build.
import { isValidStellarAddress } from "./signature";

/** Which signing scheme produced a signature — selects the server verify path. */
export type SignatureScheme = "sep53" | "albedo";

/** Which browser wallet a connection/signature came from. */
export type StellarWallet = "freighter" | "albedo";

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

/** Convert Albedo's hex `message_signature` to base64. */
export function albedoSignatureToBase64(hexSignature: string): string {
  return Buffer.from(hexSignature, "hex").toString("base64");
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
 * Connect a browser wallet and return its `G…` address. Tries Freighter first
 * (prompting for access), falling back to Albedo's `publicKey` intent when
 * Freighter isn't installed.
 */
export async function connect(): Promise<StellarConnection> {
  if (await isFreighterAvailable()) {
    const { requestAccess } = await import("@stellar/freighter-api");
    const { address, error } = await requestAccess();
    if (error) throw new Error(`Freighter access denied: ${error.message}`);
    assertAddress(address);
    return { address, wallet: "freighter" };
  }

  const albedo = (await import("@albedo-link/intent")).default;
  const { pubkey } = await albedo.publicKey({});
  assertAddress(pubkey);
  return { address: pubkey, wallet: "albedo" };
}

/**
 * Prove ownership of `expectedAddress` by signing `message` with the connected
 * wallet. Only the Freighter SEP-53 path yields a server-verifiable signature
 * today; Albedo's non-SEP-53 scheme is rejected here rather than returning a
 * signature the server would silently fail to verify (see module header).
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
    throw new Error(
      "Albedo does not produce SEP-53 signatures, so it cannot prove address " +
        "ownership server-side yet. Install Freighter to link a withdrawal address.",
    );
  }

  const { signMessage } = await import("@stellar/freighter-api");
  const res = await signMessage(message, { address: expectedAddress });
  if (res.error) throw new Error(`Freighter signing failed: ${res.error.message}`);
  if (res.signerAddress !== expectedAddress) {
    throw new Error(
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

/** Guard a wallet-returned address: reject non-StrKey / corrupted input. */
function assertAddress(address: string | undefined): asserts address is string {
  if (!address || !isValidStellarAddress(address)) {
    throw new Error(`Wallet returned an invalid Stellar address: ${address}`);
  }
}
