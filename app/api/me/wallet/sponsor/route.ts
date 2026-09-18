import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getLabelerUser, type LabelerUser } from "@/lib/labeler-auth";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import {
  accountHasUsdcTrustline,
  buildSponsoredTrustlineTx,
  getTxStatus,
  prepareSponsoredTrustline,
  StellarPaymentError,
  type PreparedSponsorship,
} from "@/lib/stellar/client";
import { readSponsorshipOnChain } from "@/lib/stellar/sponsorship-reclaim";
import { takeRateLimit, WALLET_BURST_LIMIT } from "@/lib/rate-limit";
import {
  checkSponsorAllowed,
  confirmSponsorship,
  failSponsorship,
  hasConfirmedSponsorship,
  livePendingSponsorship,
  openSponsorshipIntent,
  type SponsorshipIntentDecision,
} from "@/lib/sponsored-trustline";

/**
 * ST-4e (#314) — platform-sponsored USDC trustlines (CAP-33).
 *
 *   GET  → { needed:false, address } if the session's wallet already trusts
 *          USDC, else { needed:true, address, xdr, kind } — a platform-signed
 *          sponsored `changeTrust` (+ `createAccount` if the account is unfunded)
 *          for the wallet to co-sign.
 *   POST { signedXdr } → submit the recipient-co-signed tx; the labeler pays
 *          0 XLM (the platform sponsors the reserves).
 *
 * #30 — the address is always the session's bound wallet: the one sign-in
 * proved, and the one payouts go to. A client may still name it (`?address=` on
 * GET, `address` on POST), but a different address is refused, so no sponsorship
 * is made for an address no account holds. #29 found that a linked wallet is what
 * protects a sponsorship from reclaim. An account with no bound Stellar wallet is
 * told to bind one first. StrKey is case-sensitive — the address is never
 * lowercased.
 *
 * #27 — POST records a pending sponsorship before broadcasting, and answers only
 * what it knows. `retry` means the envelope provably cannot land, so the client
 * may rebuild. A submit whose outcome is unknown answers 202 `pending` and keeps
 * the row, because rebuilding then could sponsor the address twice.
 */
export async function GET(req: NextRequest) {
  const user = await getLabelerUser(req);
  if (!user) return unauthorized();
  const address = boundWallet(user, req.nextUrl.searchParams.get("address"));
  if (address instanceof NextResponse) return address;
  const userId = user.id;

  // Per-user throttle: the per-address limiter below gives no per-user bound — a
  // labeler could loop fresh keypairs to bypass it. The outstanding cap (#330)
  // bounds what can be spent; these bound the rate. Each allows a small burst:
  // payout setup runs on every page load, and rebuilds once after `retry`.
  const limited = (await throttle(`sponsor-get:${userId}`)) ?? (await throttle(`sponsor-build:${address}`));
  if (limited) return limited;

  try {
    if (await trustsUsdc(userId, address)) {
      return NextResponse.json({ needed: false, address });
    }
    // #330: bound outstanding sponsorships per user (a session-keyed rate throttle
    // caps *rate*, not *total outstanding* — a labeler could loop fresh keypairs to
    // drain platform reserves). Gate before building so an over-cap user never even
    // receives an XDR. Only reached when a sponsorship would actually be created
    // (needed=true), so re-linking an already-trusting address never consumes it.
    const gate = await checkSponsorAllowed(userId, address);
    if (!gate.ok) return gateRefusal(gate.reason);
    // #27: don't ask for a signature on an envelope POST would refuse to send.
    if (await livePendingSponsorship(address)) {
      return NextResponse.json({ error: "submission_pending" }, { status: 409 });
    }
    const { xdr, kind } = await buildSponsoredTrustlineTx(address);
    return NextResponse.json({ needed: true, address, xdr, kind });
  } catch (err) {
    if (err instanceof StellarPaymentError && err.code === "sponsor_low_reserve") {
      Sentry.captureException(err, { extra: { context: "sponsor-trustline-low-reserve", userId } });
      return NextResponse.json({ error: "sponsorship_unavailable" }, { status: 503 });
    }
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-build", userId } });
    return NextResponse.json({ error: "build_failed" }, { status: 502 });
  }
}

/**
 * Whether the bound wallet already trusts USDC. When Horizon cannot answer, a
 * confirmed sponsorship on the ledger stands in, so an outage does not send a
 * wallet that is already set up to the failure screen (PR #105 review). No
 * envelope is built on that answer, and a withdrawal checks the chain itself.
 */
async function trustsUsdc(userId: string, address: string): Promise<boolean> {
  try {
    return await accountHasUsdcTrustline(address);
  } catch (err) {
    if (!(await hasConfirmedSponsorship(userId, address))) throw err;
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-check-fallback", userId } });
    return true;
  }
}

/**
 * Submit a recipient-co-signed sponsorship envelope. Validates it, records the
 * intent, broadcasts, then settles the row with whatever Horizon actually said.
 */
export async function POST(req: NextRequest) {
  const user = await getLabelerUser(req);
  if (!user) return unauthorized();

  let body: { address?: unknown; signedXdr?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body.address !== undefined && typeof body.address !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const address = boundWallet(user, body.address ?? null);
  if (address instanceof NextResponse) return address;
  const userId = user.id;
  const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : "";
  if (!signedXdr) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Per-user throttle: the per-address limiter does not exist on POST (no address
  // check on the build step here), so a labeler could loop fresh keypairs to
  // submit unlimited sponsorship txs. A small burst, so the resubmission after a
  // `retry` rebuild is not refused.
  const limited = await throttle(`sponsor-submit:${userId}`);
  if (limited) return limited;

  // #330: per-user outstanding cap + cross-user address lock, re-checked here
  // (not just at build) so a client that skips GET can't bypass it.
  const gate = await checkSponsorAllowed(userId, address);
  if (!gate.ok) return gateRefusal(gate.reason);

  let prepared: PreparedSponsorship;
  try {
    prepared = prepareSponsoredTrustline(signedXdr, address);
  } catch (err) {
    if (err instanceof StellarPaymentError && err.code === "invalid_sponsor_tx") {
      return NextResponse.json({ error: "invalid_sponsor_tx" }, { status: 400 });
    }
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-prepare", userId } });
    return NextResponse.json({ error: "submit_failed" }, { status: 502 });
  }

  // Written BEFORE the irreversible step. If this fails, nothing is broadcast.
  let decision: SponsorshipIntentDecision;
  try {
    decision = await openSponsorshipIntent(
      {
        userId,
        address,
        kind: prepared.kind,
        txHash: prepared.hash,
        expiresAt: prepared.expiresAt,
      },
      { txStatus: getTxStatus, chain: readSponsorshipOnChain },
    );
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "sponsor-intent", userId, address } });
    return NextResponse.json({ error: "submit_failed" }, { status: 502 });
  }

  switch (decision.action) {
    case "address_in_use":
      return NextResponse.json({ error: "address_in_use" }, { status: 409 });
    case "already_confirmed":
      return established();
    case "prior_pending":
      return NextResponse.json({ error: "submission_pending" }, { status: 409 });
  }

  const settle = { id: decision.id, hash: prepared.hash, userId, address };
  let sent: { hash: string; feeBumpHash: string };
  try {
    sent = await prepared.submit();
  } catch (err) {
    return settleFailedSubmit(err, settle);
  }
  // #28: the row keeps the hash the contributor signed, which Horizon resolves to
  // whichever fee bump carried it. The bump's own hash is logged, not stored.
  console.info("[sponsor] sponsorship broadcast", {
    userId: settle.userId,
    address,
    hash: sent.hash,
    feeBumpHash: sent.feeBumpHash,
    kind: prepared.kind,
  });
  await confirm(settle);
  return established();
}

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Take one request from `key`'s burst. Null while it has room; otherwise the 429
 * to send, with a `Retry-After` the client can wait out instead of failing.
 */
async function throttle(key: string): Promise<NextResponse | null> {
  const decision = await takeRateLimit(key, WALLET_BURST_LIMIT);
  if (!decision.limited) return null;
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}

/**
 * The session's bound Stellar wallet, or the refusal to send. `named` is the
 * address the client sent, if any: it must be that wallet exactly.
 */
function boundWallet(user: LabelerUser, named: string | null): string | NextResponse {
  if (!user.walletAddress || !isValidStellarAddress(user.walletAddress)) {
    return NextResponse.json({ error: "wallet_required" }, { status: 409 });
  }
  if (named !== null && named !== user.walletAddress) {
    return NextResponse.json({ error: "address_not_bound" }, { status: 403 });
  }
  return user.walletAddress;
}

/** The #330 gate's refusal: 429 at the cap, 409 when another user holds the address. */
function gateRefusal(reason: "cap_reached" | "address_sponsored_by_other") {
  return NextResponse.json(
    { error: reason === "cap_reached" ? "sponsorship_cap_reached" : "address_in_use" },
    { status: reason === "cap_reached" ? 429 : 409 },
  );
}

/** The address holds its sponsored account and trustline. */
function established() {
  return NextResponse.json({ established: true });
}

type Settle = { id: string; hash: string; userId: string; address: string };

/**
 * Answer a broadcast that threw, settling the intent only on a definite result.
 * `tx_bad_seq` and an unknown outcome are both resolved by asking Horizon about
 * the hash: a stale sequence can only belong to an envelope that already landed,
 * and a timed-out one may land yet.
 */
async function settleFailedSubmit(err: unknown, settle: Settle): Promise<NextResponse> {
  const code = err instanceof StellarPaymentError ? err.code : "submission_unknown";

  // #28: `sponsor_low_reserve` here is the fee bump refused for want of XLM to pay it.
  if (code === "op_low_reserve" || code === "sponsor_low_reserve") {
    await release(settle);
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-submit", userId: settle.userId } });
    return NextResponse.json({ error: "sponsorship_unavailable" }, { status: 503 });
  }
  if (code !== "tx_bad_seq" && code !== "submission_unknown") {
    await release(settle);
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-submit", userId: settle.userId } });
    return NextResponse.json({ error: "submit_failed" }, { status: 502 });
  }

  let status: Awaited<ReturnType<typeof getTxStatus>>;
  try {
    status = await getTxStatus(settle.hash);
  } catch (lookupErr) {
    Sentry.captureException(lookupErr, { extra: { context: "sponsor-status-lookup", ...settle } });
    return pending();
  }

  if (status === "confirmed") {
    await confirm(settle);
    return established();
  }
  if (code === "tx_bad_seq") {
    await release(settle);
    return NextResponse.json({ error: "retry" }, { status: 409 });
  }
  if (status === "failed") {
    await release(settle);
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-submit", userId: settle.userId } });
    return NextResponse.json({ error: "submit_failed" }, { status: 502 });
  }
  Sentry.captureException(err, { extra: { context: "sponsor-submission-unknown", ...settle } });
  return pending();
}

/** The envelope may still land. The pending row stays, and counts, until it is resolved. */
function pending() {
  return NextResponse.json({ established: false, pending: true }, { status: 202 });
}

/**
 * Best-effort: the sponsorship is on-chain whether or not this write lands. A
 * row left pending still counts against the cap and can be reconciled by hash.
 */
async function confirm(settle: Settle): Promise<void> {
  try {
    await confirmSponsorship(settle.id, settle.hash);
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "sponsor-confirm", ...settle } });
  }
}

/** Best-effort: a row left pending only over-counts until its envelope expires. */
async function release(settle: Settle): Promise<void> {
  try {
    await failSponsorship(settle.id, settle.hash);
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "sponsor-release", ...settle } });
  }
}
