// Server-side Stellar wallet-identity verification used **only at withdrawal**
// to prove ownership of a payout address (ST-4a #299). This is NOT a login
// mechanism — login stays email/password; this just links + proves a `G…`
// address the user controls before we pay it.
//
// The browser wallet (Freighter, with Albedo as fallback — see wallet.ts) signs
// a challenge string per **SEP-53**. SEP-53 does NOT sign the raw message: it
// signs the SHA-256 of a fixed-prefix-framed message, the same anti-blind-signing
// pattern Bitcoin/Ethereum use. The exact construction is:
//
//     signature = ed25519_sign( SHA256( "Stellar Signed Message:\n" + message ) )
//
// so {@link verify} must reconstruct that digest — verifying against the raw
// message bytes would always fail. (The issue's `verify(messageBytes, …)` hint
// predates confirming the SEP-53 shape; the digest reconstruction lives here.)
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";

/** Fixed SEP-53 domain-separation prefix, UTF-8 encoded. */
const SEP53_PREFIX = Buffer.from("Stellar Signed Message:\n", "utf8");

/**
 * True iff `s` is a valid Stellar ed25519 public key (`G…`). StrKey addresses
 * are **case-sensitive base32** — this checks the raw input and never lowercases
 * or otherwise normalizes it. Lowercasing a `G…` key corrupts it and this would
 * (correctly) reject the corrupted form. Carry this no-normalization rule into
 * any address handling downstream (ST-4d).
 */
export function isValidStellarAddress(s: string): boolean {
  return StrKey.isValidEd25519PublicKey(s);
}

/**
 * The exact bytes a SEP-53 signer signs for `message`: `SHA256(prefix || msg)`.
 * Exported so wallet.ts and tests can sign/verify the identical digest.
 */
export function sep53Digest(message: string | Uint8Array): Buffer {
  const msgBytes =
    typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  return hash(Buffer.concat([SEP53_PREFIX, msgBytes]));
}

/**
 * Verify a SEP-53 ed25519 signature over `message` by `publicKey`.
 *
 * @param publicKey Stellar address (`G…`) of the claimed signer.
 * @param message   The original challenge string (or raw bytes) that was signed.
 * @param signature The 64-byte ed25519 signature, as a base64 string (Freighter
 *                  V4 / Albedo) or raw bytes (Freighter V3 Buffer).
 * @returns `true` only on a cryptographically valid signature. Returns `false`
 *          — never throws — for an invalid/lowercased/non-StrKey key or a
 *          malformed signature, so callers can treat it as a plain boolean gate.
 */
export function verify(
  publicKey: string,
  message: string | Uint8Array,
  signature: string | Uint8Array,
): boolean {
  // Reject on raw input — a non-StrKey or lowercased key never verifies, and
  // Keypair.fromPublicKey would throw on it.
  if (!isValidStellarAddress(publicKey)) return false;

  const sigBytes =
    typeof signature === "string"
      ? Buffer.from(signature, "base64")
      : Buffer.from(signature);
  // A valid ed25519 signature is exactly 64 bytes; bail early on anything else
  // (e.g. a base64-decoded garbage string) rather than handing nacl junk.
  if (sigBytes.length !== 64) return false;

  try {
    return Keypair.fromPublicKey(publicKey).verify(sep53Digest(message), sigBytes);
  } catch {
    return false;
  }
}
