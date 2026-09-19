// Claim a wallet for an account created by email (#30).
//
// connect → GET /api/me/wallet?address (a link challenge) → sign it (SEP-53) →
// POST /api/me/wallet, which binds the proven address to the signed-in account.
// From then on the account signs in with that wallet, and it is the account's
// payout destination.
//
// Every failure resolves to one {@link WalletClaimFailure}, so the UI renders a
// state rather than a raw error string. Dependencies are injectable, as in
// wallet-sign-in.
import { WalletError, connect, signOwnership } from "./wallet";

export type WalletClaimFailure =
  | "freighter_missing"
  | "rejected"
  | "wrong_account"
  | "wrong_network"
  | "unsupported"
  | "expired"
  | "address_in_use"
  | "wallet_already_bound"
  | "rate_limited"
  | "network"
  | "failed";

export type WalletClaimResult = { ok: true; address: string } | { ok: false; reason: WalletClaimFailure };

export interface WalletClaimDeps {
  connect: typeof connect;
  signOwnership: typeof signOwnership;
  fetch: typeof fetch;
}

const defaultDeps: WalletClaimDeps = {
  connect,
  signOwnership,
  fetch: (...args) => fetch(...args),
};

/** Read the `error` code from a JSON error body; undefined when there is none. */
async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** A refusal from the bind, as a failure state. */
function failureFromBind(status: number, code: string | undefined): WalletClaimFailure {
  if (code === "challenge_expired") return "expired";
  if (status === 409 && code === "address_already_linked") return "address_in_use";
  if (status === 409 && code === "wallet_already_bound") return "wallet_already_bound";
  if (status === 429) return "rate_limited";
  return "failed";
}

/** A thrown wallet or transport error, as a failure state. */
function failureFromError(err: unknown): WalletClaimFailure {
  if (err instanceof WalletError) {
    switch (err.code) {
      case "freighter_missing":
      case "rejected":
      case "wrong_account":
      case "wrong_network":
      case "unsupported":
        return err.code;
      // See wallet-sign-in.ts: an unconfigured mobile path is, to the
      // contributor, just Freighter being unreachable.
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

/** Run the whole claim. Resolves, never rejects. */
export async function claimWallet(deps: WalletClaimDeps = defaultDeps): Promise<WalletClaimResult> {
  try {
    const { address } = await deps.connect();

    const challengeRes = await deps.fetch(`/api/me/wallet?address=${encodeURIComponent(address)}`);
    if (!challengeRes.ok) {
      return { ok: false, reason: challengeRes.status === 429 ? "rate_limited" : "failed" };
    }
    const challenge = (await challengeRes.json()) as { message?: unknown };
    if (typeof challenge.message !== "string") return { ok: false, reason: "failed" };

    const proof = await deps.signOwnership(challenge.message, address);

    const bindRes = await deps.fetch("/api/me/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stellarAddress: address, signature: proof.signature }),
    });
    if (!bindRes.ok) return { ok: false, reason: failureFromBind(bindRes.status, await readError(bindRes)) };
    return { ok: true, address };
  } catch (err) {
    return { ok: false, reason: failureFromError(err) };
  }
}

/** What the contributor sees for each failure. */
export const WALLET_CLAIM_MESSAGES: Record<WalletClaimFailure, string> = {
  freighter_missing:
    "We couldn't reach Freighter. Install the Freighter browser extension, or open this " +
    "page on a phone with the Freighter app, then try again.",
  rejected: "You declined the request in Freighter. Nothing was signed — try again when you're ready.",
  wrong_account:
    "Freighter signed with a different account. Switch to the account you connected, then try again.",
  wrong_network:
    "Freighter is on a different Stellar network than Centient. Switch networks in " +
    "Freighter, then try again.",
  unsupported: "This version of Freighter can't sign messages. Update Freighter, then try again.",
  expired: "That request expired. Try again to get a fresh one.",
  address_in_use:
    "This wallet already belongs to another Centient account. Sign out, then sign in with the wallet instead.",
  wallet_already_bound:
    "This account is already connected to a different wallet. Sign out, then sign in with that wallet.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  network: "We couldn't reach Centient. Check your connection and try again.",
  failed: "Connecting your wallet didn't complete. Please try again.",
};
