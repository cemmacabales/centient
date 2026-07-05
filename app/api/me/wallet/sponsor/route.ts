import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import {
  accountHasUsdcTrustline,
  buildSponsoredTrustlineTx,
  submitSponsoredTrustline,
  StellarPaymentError,
} from "@/lib/stellar/client";
import { checkWalletRateLimit } from "@/lib/rate-limit";
import { checkSponsorAllowed, recordSponsorship } from "@/lib/sponsored-trustline";

/**
 * ST-4e (#314) — platform-sponsored USDC trustlines (CAP-33).
 *
 *   GET  ?address → { needed:false } if the address already trusts USDC, else
 *                   { needed:true, xdr, kind } — a platform-signed sponsored
 *                   `changeTrust` (+ `createAccount` if the account is unfunded)
 *                   for the wallet to co-sign.
 *   POST { address, signedXdr } → submit the recipient-co-signed tx; the labeler
 *                   pays 0 XLM (the platform sponsors the reserves).
 *
 * Replaces ST-4b's hard `no_trustline` reject with an in-app funded flow. StrKey
 * is case-sensitive — the address is never lowercased.
 */
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const address = req.nextUrl.searchParams.get("address");
  if (!address || !isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  // Per-user throttle: the per-address limiter below gives no per-user bound — a
  // labeler could loop fresh keypairs to bypass it. This session-keyed check is a
  // stopgap; a proper cap on outstanding sponsorships per labeler is tracked as a
  // follow-up before ST-7 mainnet (issue link will be added).
  if (await checkWalletRateLimit(`sponsor-get:${userId}`)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (await checkWalletRateLimit(`sponsor-build:${address}`)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    if (await accountHasUsdcTrustline(address)) {
      return NextResponse.json({ needed: false });
    }
    // #330: bound outstanding sponsorships per user (a session-keyed rate throttle
    // caps *rate*, not *total outstanding* — a labeler could loop fresh keypairs to
    // drain platform reserves). Gate before building so an over-cap user never even
    // receives an XDR. Only reached when a sponsorship would actually be created
    // (needed=true), so re-linking an already-trusting address never consumes it.
    const gate = await checkSponsorAllowed(userId!, address);
    if (!gate.ok) {
      return NextResponse.json(
        { error: gate.reason === "cap_reached" ? "sponsorship_cap_reached" : "address_in_use" },
        { status: gate.reason === "cap_reached" ? 429 : 409 },
      );
    }
    const { xdr, kind } = await buildSponsoredTrustlineTx(address);
    return NextResponse.json({ needed: true, xdr, kind });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-build", userId } });
    return NextResponse.json({ error: "build_failed" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  let body: { address?: unknown; signedXdr?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const address = typeof body.address === "string" ? body.address : "";
  const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : "";
  if (!isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  if (!signedXdr) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Per-user throttle: the per-address limiter does not exist on POST (no address
  // check on the build step here), so a labeler could loop fresh keypairs to
  // submit unlimited sponsorship txs. This session-keyed check is a stopgap; a
  // proper cap on outstanding sponsorships per labeler is tracked as a follow-up
  // before ST-7 mainnet (issue link will be added).
  if (await checkWalletRateLimit(`sponsor-submit:${userId}`)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // #330: authoritative per-user outstanding cap + cross-user address lock,
  // re-checked here (not just at build) so a client that skips GET can't bypass it.
  const gate = await checkSponsorAllowed(userId!, address);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.reason === "cap_reached" ? "sponsorship_cap_reached" : "address_in_use" },
      { status: gate.reason === "cap_reached" ? 429 : 409 },
    );
  }

  try {
    const { hash, kind } = await submitSponsoredTrustline(signedXdr, address);
    // Record the locked reserve so it counts against the cap. Best-effort: the
    // trustline IS established on-chain even if this write fails, so don't fail the
    // request — but surface it, since an unrecorded sponsorship under-counts the cap.
    try {
      await recordSponsorship({ userId: userId!, address, kind, txHash: hash });
    } catch (recordErr) {
      Sentry.captureException(recordErr, { extra: { context: "sponsor-record", userId, address } });
    }
    return NextResponse.json({ established: true });
  } catch (err) {
    if (err instanceof StellarPaymentError) {
      if (err.code === "tx_bad_seq") {
        return NextResponse.json({ error: "retry" }, { status: 409 });
      }
      if (err.code === "op_low_reserve") {
        return NextResponse.json({ error: "sponsorship_unavailable" }, { status: 503 });
      }
      if (err.code === "invalid_sponsor_tx") {
        return NextResponse.json({ error: "invalid_sponsor_tx" }, { status: 400 });
      }
    }
    Sentry.captureException(err, { extra: { context: "sponsor-trustline-submit", userId } });
    return NextResponse.json({ error: "submit_failed" }, { status: 502 });
  }
}
