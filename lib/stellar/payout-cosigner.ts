// Resolution of the independent payout co-signer (issue #7).
//
// The payout account is a 2-of-3 multisig precisely so that no single process
// can move contributor funds. Issue #8 supplies the real second signer: an
// isolated policy service that re-derives the task ledger over authenticated
// transport and signs only what it independently agrees to pay.
//
// Until that service exists, this module provides the same contract in-process
// so the rail can be proven end to end on testnet — the two-signature settlement
// issue #7 must demonstrate. That local signer is a development affordance, not
// a deployment option: one process holding both keys is single-party control
// wearing a multisig's clothes. It is therefore refused on the public network and
// requires an explicit opt-in even on testnet, and the absence of any configured
// co-signer fails closed rather than degrading to a single signature.
import { Keypair, type Asset } from "@stellar/stellar-sdk";
import { stellarNetwork, usdcAsset } from "./config";
import { assertIsolationPermitted } from "./cosigner-isolation";
import { remotePolicyCoSigner } from "./cosigner-remote";
import { assertEnvelopeMatchesRequest } from "./cosigner-verify";
import type { PayoutCoSignRequest, PayoutCoSignature, PayoutCoSigner } from "./payout-envelope";

export type PayoutCoSignerEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * An in-process co-signer holding the policy key directly. Signs only after
 * re-deriving the envelope's payment and matching it against the request, so it
 * exercises the same refusal paths the real service must.
 */
export function localPolicyCoSigner(policy: Keypair, asset?: Asset): PayoutCoSigner {
  return {
    async signPayout(request: PayoutCoSignRequest): Promise<PayoutCoSignature> {
      const transaction = assertEnvelopeMatchesRequest(request, asset ?? usdcAsset());
      return {
        publicKey: policy.publicKey(),
        signature: policy.sign(transaction.hash()).toString("base64"),
      };
    },
  };
}

/**
 * Refuse an application deployment that can produce both payout signatures.
 *
 * A process configured to call the separate co-signer must not also hold the
 * policy signing key: if it does, the two signing boundaries have collapsed into
 * one and the multisig is decorative. Silently preferring the remote signer
 * would leave the key sitting in a process one code change away from using it.
 *
 * Called both at startup (`instrumentation.ts`) and on the payout path. Startup
 * is where a collapsed boundary should surface — a deployment that has lost the
 * separation is wrong the moment it comes up, not hours later when the first
 * contributor tries to get paid.
 */
export function assertAppDeploymentSeparation(
  env: PayoutCoSignerEnvironment = process.env,
): void {
  if (env.COSIGNER_URL?.trim() && env.STELLAR_POLICY_SIGNER_SECRET?.trim()) {
    throw new Error(
      "this process is configured with both COSIGNER_URL and STELLAR_POLICY_SIGNER_SECRET — the app deployment must never hold the policy signing key (ADR-0001)",
    );
  }
}

/**
 * The co-signer this deployment may use. Throws rather than returning a
 * single-signature fallback: there is no configuration of this rail that pays out
 * on one signature.
 */
export function resolvePayoutCoSigner(
  env: PayoutCoSignerEnvironment = process.env,
): PayoutCoSigner {
  const remoteUrl = env.COSIGNER_URL?.trim();
  const secret = env.STELLAR_POLICY_SIGNER_SECRET?.trim();

  assertAppDeploymentSeparation(env);

  // The deployed service is the real co-signer and takes precedence: the local
  // signer below exists only so the refusal paths stay exercised in development.
  if (remoteUrl) {
    assertIsolationPermitted(env);
    const sharedSecret = env.COSIGNER_SHARED_SECRET?.trim();
    if (!sharedSecret) {
      throw new Error(
        "COSIGNER_SHARED_SECRET must be set to authenticate requests to the co-signer at COSIGNER_URL",
      );
    }
    // The HMAC proves who sent the request and that it arrived intact; it does
    // not conceal it. Over plaintext the destination, the amount, the envelope
    // XDR, and the signature coming back are all readable in transit — and the
    // co-signer's own Railway project means this crosses the public internet.
    // Loopback stays exempt so a local co-signer is still usable in development.
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new Error(`COSIGNER_URL is not a usable URL: "${remoteUrl}"`);
    }
    // Two exemptions, both cases where the request provably does not traverse a
    // network a stranger can read: the local machine, and Railway's per-project
    // private network. The co-signer shares a project with the app under
    // ADR-0001's amendment, so the private domain is the normal path there and
    // forcing TLS would push the request out through a public domain instead —
    // more exposure, not less. The suffix is matched with a leading dot so a
    // public host cannot claim it by merely ending with the same characters.
    const { hostname } = parsed;
    const loopback = hostname === "localhost" || hostname === "127.0.0.1";
    const railwayPrivate = hostname.endsWith(".railway.internal");
    if (parsed.protocol !== "https:" && !loopback && !railwayPrivate) {
      throw new Error(
        `COSIGNER_URL must use https (got "${parsed.protocol}") — payout details are never sent to the co-signer over plaintext`,
      );
    }

    return remotePolicyCoSigner({ url: remoteUrl, secret: sharedSecret });
  }

  if (!secret) {
    throw new Error(
      "no payout co-signer is configured — set STELLAR_POLICY_SIGNER_SECRET for the gated local signer, or wire the issue #8 policy service",
    );
  }

  // Resolved from stellarNetwork() alone, which is the same authority
  // networkPassphrase() uses to parse and sign the envelope. Reading a separately
  // supplied value here would let the two disagree, and an empty string would slip
  // past this refusal by simply not equalling "public".
  if (stellarNetwork() === "public") {
    throw new Error(
      "the local payout co-signer is never permitted on the public network — one process holding both keys is not a 2-of-3",
    );
  }
  if (env.STELLAR_ALLOW_LOCAL_COSIGNER?.trim() !== "true") {
    throw new Error(
      "STELLAR_ALLOW_LOCAL_COSIGNER must be exactly \"true\" to co-sign payouts in-process",
    );
  }

  const policy = Keypair.fromSecret(secret);
  const expectedPublic = env.STELLAR_POLICY_SIGNER_PUBLIC?.trim();
  if (expectedPublic && expectedPublic !== policy.publicKey()) {
    throw new Error(
      `STELLAR_POLICY_SIGNER_SECRET does not match STELLAR_POLICY_SIGNER_PUBLIC (${expectedPublic})`,
    );
  }
  return localPolicyCoSigner(policy);
}
