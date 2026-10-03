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
//
// #170: on the Freighter mobile app, sign-in may already have asked for this
// signature, in the same visit to Freighter as its own proof, and handed it over
// with {@link handOffPayoutSignature}. Setup then submits that envelope instead
// of building one and sending the contributor to Freighter a third time.
import { WalletError, signTransaction } from "./wallet";

const SPONSOR_URL = "/api/me/wallet/sponsor";

/** The envelope shapes the sponsor route builds. */
export type SponsorshipEnvelopeKind = "trustline" | "account+trustline";

/**
 * A payout-setup signature asked for at sign-in (#170), on an envelope the
 * challenge route offered: one the sponsor hasn't signed yet, which it signs when
 * `offer` comes back with it.
 */
export interface EarlyPayoutSignature {
  /** The address sign-in proved; the sponsor route refuses it unless it is the bound wallet. */
  address: string;
  kind: SponsorshipEnvelopeKind;
  /** The challenge route's tag for the envelope, sent back with it. */
  offer: string;
  /** When the envelope stops being valid, in epoch milliseconds. */
  expiresAt: number;
  /** The co-signed envelope; see `StellarProofAndTransaction`. */
  signedTransaction: () => Promise<string>;
}

/**
 * How long before the envelope's own expiry setup stops trusting it: the submit
 * and the broadcast take time, and the browser's clock may differ from the
 * server's. Past this, setup builds a fresh envelope instead.
 */
export const EARLY_ENVELOPE_MARGIN_MS = 30_000;

let earlySignature: EarlyPayoutSignature | null = null;

/**
 * Leave a signature for the next setup to use. Sign-in and setup run in the same
 * page with no reload between them, so this is held in memory, and consumed by
 * the first setup that runs.
 */
export function handOffPayoutSignature(signature: EarlyPayoutSignature): void {
  earlySignature = signature;
}

/** Take the signature sign-in left, if any, so no later setup reuses it. */
export function takeEarlyPayoutSignature(): EarlyPayoutSignature | null {
  const signature = earlySignature;
  earlySignature = null;
  return signature;
}

export type PayoutSetupFailure =
  | "wallet_required"
  | "freighter_missing"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "wrong_account"
  | "wrong_network"
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
  /** The signature sign-in left, if any; {@link takeEarlyPayoutSignature} by default. */
  takeEarlySignature?: () => EarlyPayoutSignature | null;
  /** Injectable for tests; `Date.now` by default. */
  now?: () => number;
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
      case "cancelled":
      case "timed_out":
      case "wrong_account":
      case "wrong_network":
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
 *
 * `stillWorthSending` is asked after the wait: when it says no, the throttled
 * answer is returned instead of resending. An envelope from sign-in (#170) can
 * expire during a wait of up to {@link MAX_RATE_LIMIT_WAIT_SECONDS}.
 */
async function send(
  deps: PayoutSetupDeps,
  init?: RequestInit,
  stillWorthSending: () => boolean = () => true,
): Promise<Response> {
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
  if (!stillWorthSending()) return res;
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
    const early = (deps.takeEarlySignature ?? takeEarlyPayoutSignature)();
    if (early) {
      const result = await submitEarlySignature(deps, early);
      if (result) return result;
    }

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
 * Refusals that say only that the envelope from sign-in can't be used: its
 * sequence was taken (`retry`), the route won't take it (`invalid_sponsor_tx`, as
 * after a sponsor key change), or it names an address this session doesn't hold.
 * Setup builds a fresh envelope instead of reporting them.
 */
const UNUSABLE_EARLY_ENVELOPE = new Set(["409 retry", "400 invalid_sponsor_tx", "403 address_not_bound"]);

/**
 * Submit the envelope co-signed at sign-in (#170). Resolves with the outcome, as
 * the ordinary submit would report it, or null when that envelope can't be used
 * and setup should build a fresh one. Its signature is normally already in: if
 * not, collecting it takes the contributor back to Freighter, where it waits.
 */
async function submitEarlySignature(
  deps: PayoutSetupDeps,
  early: EarlyPayoutSignature,
): Promise<PayoutSetupResult | null> {
  const now = deps.now ?? Date.now;
  const usable = () => now() < early.expiresAt - EARLY_ENVELOPE_MARGIN_MS;
  if (!usable()) return null;

  let signedXdr: string;
  deps.onSigning?.(early.kind);
  try {
    signedXdr = await early.signedTransaction();
  } finally {
    deps.onSigning?.(null);
  }
  // It may have sat unanswered in Freighter for a while.
  if (!usable()) return null;

  const submit = await send(
    deps,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: early.address, signedXdr, offer: early.offer }),
    },
    usable,
  );
  // Throttled until the envelope was too close to expiry to resend.
  if (submit.status === 429 && !usable()) return null;
  if (submit.status === 202) return { ok: false, reason: "pending" };
  if (submit.ok) return { ok: true, address: early.address, sponsored: true };
  const refusal = await readJson(submit);
  if (UNUSABLE_EARLY_ENVELOPE.has(`${submit.status} ${String(refusal.error)}`)) return null;
  return { ok: false, reason: failureFromResponse(submit.status, refusal.error) };
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
    "We couldn't reach Freighter. Install the Freighter browser extension, or open this " +
    "page on a phone with the Freighter app, then try again.",
  rejected: "You declined in Freighter. Nothing was submitted — try again when you're ready.",
  cancelled: "You cancelled the request to Freighter. Nothing was submitted — try again when you're ready.",
  timed_out: "Freighter didn't answer in time. Open the Freighter app, then try again.",
  wrong_account:
    "Freighter signed with a different account. Switch to the wallet you signed in with, then try again.",
  wrong_network:
    "Freighter is on a different Stellar network than Centient. Switch networks in " +
    "Freighter, then try again.",
  pending: "Your wallet setup is still confirming on the network. Try again in a minute.",
  cap_reached:
    "You've reached the limit of payout wallets we can set up for your account. Contact centient@artisam.xyz.",
  address_in_use: "This Stellar address is already set up for another account.",
  unavailable: "Payout setup is temporarily unavailable. Please try again shortly.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  network: "We couldn't reach Centient. Check your connection and try again.",
  failed: "Payout setup didn't complete. Please try again.",
};
