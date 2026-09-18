// The text a contributor signs to prove they control a Stellar address.
//
// #24 settled this format against the real Freighter extension; #25 signs
// contributors in with it. Pure on purpose — no database, no network — so the
// testnet proof harness can share the exact signed bytes without loading
// Prisma, and so the two can never drift apart.

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * The `Action:` line of a sign-in proof, and the `wallet_nonces.action` value
 * its challenge row carries.
 */
export const PROOF_ACTION = "prove-stellar-address";

/**
 * `wallet_nonces.action` for the Deliverable 1 payout-address link flow
 * (`/api/me/wallet`). That flow signs its own, older message; the value exists
 * only so the two flows' queries cannot reach each other's rows.
 */
export const WALLET_LINK_ACTION = "link-payout-address";

export interface ChallengeFields {
  address: string;
  networkPassphrase: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * The exact text Freighter signs. SEP-53 has no network or domain field of its
 * own, so every binding the verifier relies on has to live in the message.
 */
export function buildChallengeMessage(fields: ChallengeFields): string {
  return [
    "Centient: prove you control this Stellar address.",
    "",
    `Address: ${fields.address}`,
    `Network: ${fields.networkPassphrase}`,
    `Action: ${PROOF_ACTION}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expires At: ${fields.expiresAt.toISOString()}`,
  ].join("\n");
}
