// Passwordless contributor sign-in with Freighter (#26).
//
// connect → POST /api/auth/wallet/challenge → sign the challenge (SEP-53) →
// POST /api/auth/wallet/verify, which sets the `labeler_session` cookie (#25).
//
// Every failure resolves to one {@link WalletSignInFailure} so the UI renders a
// state rather than a raw error string. Dependencies are injectable so the flow
// is testable without a browser, a Freighter extension or a server.
import { WalletError, connect, signOwnership } from "./wallet";

export type WalletSignInFailure =
  | "freighter_missing"
  | "rejected"
  | "wrong_account"
  | "wrong_network"
  | "unsupported"
  | "expired"
  | "rate_limited"
  | "network"
  | "failed";

export type WalletSignInResult =
  | { ok: true; address: string; created: boolean }
  | { ok: false; reason: WalletSignInFailure };

export interface WalletSignInDeps {
  connect: typeof connect;
  signOwnership: typeof signOwnership;
  fetch: typeof fetch;
}

const defaultDeps: WalletSignInDeps = {
  connect,
  signOwnership,
  fetch: (...args) => fetch(...args),
};

/** Verify rejections from #25 that a fresh challenge and a new attempt can fix. */
const EXPIRED_REASONS = new Set(["challenge_expired", "challenge_not_found"]);
/** Verify rejections that mean the proof came from a different account. */
const WRONG_ACCOUNT_REASONS = new Set(["wrong_signer", "wrong_address"]);

/** Read the `error` code from a JSON error body; undefined when there is none. */
async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** POST `body` as JSON through the injected fetch. */
function postJson(deps: WalletSignInDeps, url: string, body: unknown): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Map a thrown wallet or transport error to a failure state. */
function failureFromError(err: unknown): WalletSignInFailure {
  if (err instanceof WalletError) {
    switch (err.code) {
      case "freighter_missing":
      case "rejected":
      case "wrong_account":
      case "wrong_network":
      case "unsupported":
        return err.code;
      // No WalletConnect project id configured: there is no mobile path on
      // this deployment, so from the contributor's side Freighter is simply
      // out of reach — the same dead end as a missing extension.
      case "walletconnect_unconfigured":
        return "freighter_missing";
      default:
        return "failed";
    }
  }
  // fetch rejects with a TypeError when the request never reaches the server.
  if (err instanceof TypeError) return "network";
  return "failed";
}

/**
 * Run the whole sign-in. Resolves, never rejects: success carries the proven
 * address (exactly as Freighter returned it) and whether the account is new.
 */
export async function signInWithWallet(
  deps: WalletSignInDeps = defaultDeps,
): Promise<WalletSignInResult> {
  try {
    const { address } = await deps.connect();

    const challengeRes = await postJson(deps, "/api/auth/wallet/challenge", { address });
    if (!challengeRes.ok) {
      return { ok: false, reason: challengeRes.status === 429 ? "rate_limited" : "failed" };
    }
    const challenge = (await challengeRes.json()) as { nonce?: unknown; message?: unknown };
    if (typeof challenge.nonce !== "string" || typeof challenge.message !== "string") {
      return { ok: false, reason: "failed" };
    }

    const proof = await deps.signOwnership(challenge.message, address);

    const verifyRes = await postJson(deps, "/api/auth/wallet/verify", {
      address,
      nonce: challenge.nonce,
      signature: proof.signature,
      signerAddress: proof.address,
    });
    if (!verifyRes.ok) {
      const code = await readError(verifyRes);
      if (code && EXPIRED_REASONS.has(code)) return { ok: false, reason: "expired" };
      if (code && WRONG_ACCOUNT_REASONS.has(code)) return { ok: false, reason: "wrong_account" };
      return { ok: false, reason: "failed" };
    }
    const verified = (await verifyRes.json()) as { created?: unknown };
    return { ok: true, address, created: verified.created === true };
  } catch (err) {
    return { ok: false, reason: failureFromError(err) };
  }
}

/** What the contributor sees for each failure. */
export const WALLET_SIGN_IN_MESSAGES: Record<WalletSignInFailure, string> = {
  freighter_missing:
    "We couldn't reach Freighter. Install the Freighter browser extension, or open this " +
    "page on a phone with the Freighter app, then try again.",
  rejected: "You declined the request in Freighter. Nothing was signed — try again when you're ready.",
  wrong_account:
    "Freighter signed with a different account. Switch to the account you connected, then try again.",
  wrong_network:
    "Freighter is on a different Stellar network than Centient. Switch networks in " +
    "Freighter, then try again.",
  unsupported: "This version of Freighter can't sign in. Update Freighter, then try again.",
  expired: "That sign-in request expired. Try again to get a fresh one.",
  rate_limited: "Too many sign-in attempts. Wait a minute, then try again.",
  network: "We couldn't reach Centient. Check your connection and try again.",
  failed: "Sign-in didn't complete. Please try again.",
};
