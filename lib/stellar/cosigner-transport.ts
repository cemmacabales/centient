// Authenticated transport between the payout service and the co-signer (issue #8).
//
// ADR-0001 puts the co-signer in its own Railway project, which means the signing
// request crosses the public internet rather than a trusted private network. That
// is the more honest arrangement — the real deployment on a separate account would
// cross it too — but it only holds if the request proves where it came from.
//
// What this buys and what it does not: the HMAC establishes that the caller holds
// the shared secret and that the body was not altered in transit. It is not what
// makes the co-signature safe. Even a caller who holds the secret cannot obtain a
// signature for a payout the ledger does not owe, because `assertLedgerAgrees`
// re-derives it independently. The transport keeps strangers out; the ledger check
// keeps the co-signer honest.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const COSIGNER_SIGNATURE_HEADER = "x-centient-signature";
export const COSIGNER_TIMESTAMP_HEADER = "x-centient-timestamp";
export const COSIGNER_NONCE_HEADER = "x-centient-nonce";

/** How far a request's timestamp may be from the verifier's clock, either way. */
export const REPLAY_WINDOW_MS = 5 * 60_000;

/** A shorter secret is not worth the verification it implies. */
const MIN_SECRET_LENGTH = 32;

/**
 * Single-use nonce storage. `take` returns false if the nonce was already spent.
 *
 * The service's default is in-process, which is sound only while exactly one
 * co-signer instance runs — the same single-writer constraint the payout submitter
 * already carries. Scaling the co-signer past one replica means backing this with
 * shared storage first, or the replay guard silently stops guarding.
 */
export interface NonceStore {
  take(nonce: string): boolean;
}

export type SignedHeaders = Record<string, string>;

function assertUsableSecret(secret: string): void {
  if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `COSIGNER_SHARED_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

/** The signed preimage: body, timestamp, and nonce, so none can be swapped alone. */
function preimage(body: string, timestamp: string, nonce: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

function digest(body: string, secret: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", secret).update(preimage(body, timestamp, nonce)).digest("hex");
}

/** Sign a request body, returning the headers the co-signer verifies. */
export function signCoSignRequest(
  body: string,
  secret: string,
  options: { now?: number; nonce?: string } = {},
): SignedHeaders {
  assertUsableSecret(secret);
  const timestamp = String(options.now ?? Date.now());
  const nonce = options.nonce ?? randomUUID();
  return {
    [COSIGNER_TIMESTAMP_HEADER]: timestamp,
    [COSIGNER_NONCE_HEADER]: nonce,
    [COSIGNER_SIGNATURE_HEADER]: digest(body, secret, timestamp, nonce),
  };
}

/**
 * Verify a signed request, throwing on the first thing that does not hold.
 *
 * The freshness window and the nonce do different jobs and both are needed: the
 * window bounds how long a captured request stays interesting (and bounds the
 * nonce store), while the nonce stops a replay inside that window.
 */
export function verifyCoSignRequest(
  body: string,
  headers: Readonly<Record<string, string | undefined>>,
  secret: string,
  options: { now?: number; nonces: NonceStore },
): void {
  assertUsableSecret(secret);
  const now = options.now ?? Date.now();

  const signature = headers[COSIGNER_SIGNATURE_HEADER]?.trim();
  const timestamp = headers[COSIGNER_TIMESTAMP_HEADER]?.trim();
  const nonce = headers[COSIGNER_NONCE_HEADER]?.trim();
  if (!signature || !timestamp || !nonce) {
    throw new Error(
      `payout co-signer: request must carry ${COSIGNER_SIGNATURE_HEADER}, ${COSIGNER_TIMESTAMP_HEADER}, and ${COSIGNER_NONCE_HEADER}`,
    );
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > REPLAY_WINDOW_MS) {
    throw new Error(
      `payout co-signer: request timestamp ${timestamp} is outside the ${REPLAY_WINDOW_MS}ms replay window`,
    );
  }

  // Compared before the nonce is spent, so a forged signature cannot burn a nonce
  // the legitimate caller is about to use.
  const expected = Buffer.from(digest(body, secret, timestamp, nonce), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw new Error("payout co-signer: request signature does not verify");
  }

  if (!options.nonces.take(nonce)) {
    throw new Error(`payout co-signer: nonce ${nonce} was already used — refusing a replay`);
  }
}
