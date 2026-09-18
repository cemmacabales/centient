// Payout setup for the session's bound wallet (#30).
//
// GET /api/me/wallet/sponsor → the wallet already trusts USDC: ready. Otherwise
// the contributor co-signs the sponsored envelope in Freighter and it is POSTed
// back; Centient pays the fee and the reserves, so the contributor needs no XLM.
// The route only ever sponsors the session's own wallet, so no address is sent.
//
// Every outcome resolves to one {@link PayoutSetupResult}, so the UI renders a
// state rather than a raw error string. Running it again is always safe: an
// address that is already set up answers ready without a signature, and a
// declined or refused attempt submitted nothing. Dependencies are injectable, as
// in wallet-sign-in.
import { WalletError, signTransaction } from "./wallet";

const SPONSOR_URL = "/api/me/wallet/sponsor";

/** The envelope shapes the sponsor route builds. */
export type SponsorshipEnvelopeKind = "trustline" | "account+trustline";

export type PayoutSetupFailure =
  | "wallet_required"
  | "freighter_missing"
  | "rejected"
  | "wrong_account"
  | "pending"
  | "cap_reached"
  | "address_in_use"
  | "unavailable"
  | "rate_limited"
  | "network"
  | "failed";

export type PayoutSetupResult =
  | { ok: true; address: string; sponsored: boolean }
  | { ok: false; reason: PayoutSetupFailure };

export interface PayoutSetupDeps {
  signTransaction: typeof signTransaction;
  fetch: typeof fetch;
  /** Told the envelope kind while Freighter is open, and null once it closes. */
  onSigning?: (kind: SponsorshipEnvelopeKind | null) => void;
  /** Told the seconds being waited out after a rate limit, and null once the wait ends. */
  onWaiting?: (seconds: number | null) => void;
  /** Injectable for tests; a real timer by default. */
  sleep?: (ms: number) => Promise<void>;
}

/** The longest `Retry-After` the flow waits out; a longer one is reported instead. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

const defaultDeps: PayoutSetupDeps = {
  signTransaction,
  fetch: (...args) => fetch(...args),
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read a JSON body; an empty object when there is none. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A refusal from either sponsor endpoint, as a failure state. */
function failureFromResponse(status: number, code: unknown): PayoutSetupFailure {
  if (status === 409 && code === "wallet_required") return "wallet_required";
  if (status === 409 && code === "address_in_use") return "address_in_use";
  if (status === 409 && code === "submission_pending") return "pending";
  if (status === 429 && code === "sponsorship_cap_reached") return "cap_reached";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return "failed";
}

/** A thrown wallet or transport error, as a failure state. */
function failureFromError(err: unknown): PayoutSetupFailure {
  if (err instanceof WalletError) {
    switch (err.code) {
      case "freighter_missing":
      case "rejected":
      case "wrong_account":
        return err.code;
      default:
        return "failed";
    }
  }
  // fetch rejects with a TypeError when the request never reaches the server.
  if (err instanceof TypeError) return "network";
  return "failed";
}

/**
 * Seconds to wait out a throttled response, or null when there is nothing to
 * wait for: not a 429 `rate_limited` (the sponsorship cap is also a 429), or no
 * usable `Retry-After` within {@link MAX_RATE_LIMIT_WAIT_SECONDS}.
 */
async function rateLimitWait(res: Response): Promise<number | null> {
  if (res.status !== 429) return null;
  if ((await readJson(res.clone())).error !== "rate_limited") return null;
  const seconds = Number(res.headers.get("Retry-After"));
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RATE_LIMIT_WAIT_SECONDS) return null;
  return Math.ceil(seconds);
}

/**
 * One sponsor request. A rate limit is a wait, not a failure: the request is
 * sent again, once, after the `Retry-After` the route gave. Resending a submit
 * is safe, because a throttled POST is refused before any intent is written.
 */
async function send(deps: PayoutSetupDeps, init?: RequestInit): Promise<Response> {
  const request = () => (init ? deps.fetch(SPONSOR_URL, init) : deps.fetch(SPONSOR_URL));
  const res = await request();
  const wait = await rateLimitWait(res);
  if (wait === null) return res;
  deps.onWaiting?.(wait);
  try {
    await (deps.sleep ?? realSleep)(wait * 1000);
  } finally {
    deps.onWaiting?.(null);
  }
  return request();
}

/**
 * Make the bound wallet able to receive USDC. Resolves, never rejects. One
 * rebuild on `retry`, which the route answers only when the envelope provably
 * cannot land (a concurrent sponsor transaction took the sequence). A short rate
 * limit on either request is waited out rather than reported.
 */
export async function setUpPayouts(deps: PayoutSetupDeps = defaultDeps): Promise<PayoutSetupResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const build = await send(deps);
      const offer = await readJson(build);
      if (!build.ok) return { ok: false, reason: failureFromResponse(build.status, offer.error) };
      if (typeof offer.address !== "string") return { ok: false, reason: "failed" };
      const address = offer.address;
      if (offer.needed === false) return { ok: true, address, sponsored: false };
      if (typeof offer.xdr !== "string") return { ok: false, reason: "failed" };

      const kind: SponsorshipEnvelopeKind = offer.kind === "trustline" ? "trustline" : "account+trustline";
      let signedXdr: string;
      deps.onSigning?.(kind);
      try {
        signedXdr = await deps.signTransaction(offer.xdr, address);
      } finally {
        deps.onSigning?.(null);
      }

      const submit = await send(deps, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedXdr }),
      });
      // 202: the outcome is not known yet. Rebuilding now could sponsor twice.
      if (submit.status === 202) return { ok: false, reason: "pending" };
      if (submit.ok) return { ok: true, address, sponsored: true };
      const refusal = await readJson(submit);
      if (submit.status === 409 && refusal.error === "retry") continue;
      return { ok: false, reason: failureFromResponse(submit.status, refusal.error) };
    }
    return { ok: false, reason: "failed" };
  } catch (err) {
    return { ok: false, reason: failureFromError(err) };
  }
}

/**
 * #28: shown while Freighter asks for the sponsorship signature. Freighter
 * summarises the envelope as "USDC · Add Trustline" and shows its inner fee, which
 * the sponsor's fee bump pays instead. Without this, a contributor holding no XLM
 * may reasonably decline a fee they cannot pay.
 */
export const PAYOUT_SIGNING_NOTICE: Record<SponsorshipEnvelopeKind, string> = {
  trustline:
    "Approve in Freighter to add USDC to your wallet. Centient pays the network fee and the reserve — the fee Freighter shows is not charged to you, and you need no XLM.",
  "account+trustline":
    "Approve in Freighter to create your Stellar account and add USDC. Centient pays the network fee and the reserves — the fee Freighter shows is not charged to you, and you need no XLM.",
};

/** Shown while a rate limit is waited out; setup carries on by itself. */
export function payoutWaitingNotice(seconds: number): string {
  return `Lots of attempts in a short time. Carrying on automatically in about ${seconds} seconds…`;
}

/** What the contributor sees for each failure. */
export const PAYOUT_SETUP_MESSAGES: Record<PayoutSetupFailure, string> = {
  wallet_required: "Connect your Stellar wallet to this account first.",
  freighter_missing:
    "Freighter isn't installed or isn't reachable. Install the Freighter browser extension, then try again.",
  rejected: "You declined in Freighter. Nothing was submitted — try again when you're ready.",
  wrong_account:
    "Freighter signed with a different account. Switch to the wallet you signed in with, then try again.",
  pending: "Your wallet setup is still confirming on the network. Try again in a minute.",
  cap_reached:
    "You've reached the limit of payout wallets we can set up for your account. Contact centient@artisam.xyz.",
  address_in_use: "This Stellar address is already set up for another account.",
  unavailable: "Payout setup is temporarily unavailable. Please try again shortly.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  network: "We couldn't reach Centient. Check your connection and try again.",
  failed: "Payout setup didn't complete. Please try again.",
};
