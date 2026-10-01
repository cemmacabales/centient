import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { issueSignInChallenge } from "@/lib/stellar/auth-challenge";
import {
  accountHasUsdcTrustline,
  buildSponsorshipOffer,
  type SponsorshipOffer,
} from "@/lib/stellar/client";
import { livePendingSponsorship } from "@/lib/sponsored-trustline";
import { checkWalletRateLimit, WALLET_BURST_LIMIT, type RateLimit } from "@/lib/rate-limit";
import { withDeadline } from "@/lib/deadline";

/** Per IP: wider than per address, since contributors behind one NAT share it. */
export const CHALLENGE_IP_LIMIT: RateLimit = { max: 20, windowMs: 60_000 };

/**
 * The longest sign-in waits on payout setup's envelope (#170). `@stellar/
 * stellar-sdk` waits on Horizon forever by default, and the challenge is already
 * issued, and ticking, by then. Normally the handful of Horizon reads take well
 * under this. Past it, the challenge goes out alone and payout setup builds its
 * own envelope after sign-in: one more trip to Freighter, never a stuck sign-in.
 */
export const PAYOUT_SETUP_OFFER_DEADLINE_MS = 4_000;

/** Read the client address supplied by the trusted deployment proxy, if any. */
function clientIp(req: NextRequest): string | null {
  // x-real-ip is set by Railway's proxy and cannot be overridden by the client;
  // the first x-forwarded-for entry can. Same reasoning as /api/auth/login.
  return req.headers.get("x-real-ip");
}

/**
 * POST /api/auth/wallet/challenge — issue a one-time wallet sign-in challenge (#25).
 *
 * Public: a contributor has no session yet. The response carries the exact text
 * to sign with Freighter's `signMessage`; the proof goes to
 * `/api/auth/wallet/verify`, within five minutes, once.
 *
 * Two throttles, because the endpoint writes a row and needs no session: per
 * address, which bounds churn on one address, and per IP, which bounds a caller
 * looping fresh addresses. Both allow a small burst, so declining the Freighter
 * prompt and trying again straight away works. Without a proxy-supplied IP the
 * per-IP throttle is skipped rather than pooling every such request under one
 * key; the per-address throttle still applies.
 *
 * #170: with `payoutSetup: true`, the response also carries `sponsorship`, the
 * USDC-trustline envelope payout setup will need, when the address needs one.
 * The Freighter mobile app then signs both in one visit instead of two. See
 * {@link payoutSetupOffer} for why that is safe to hand out before sign-in.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const address = typeof fields.address === "string" ? fields.address : "";

  // No normalization: StrKey is case-sensitive, so a lowercased key is refused.
  if (!isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  const ip = clientIp(req);
  if (ip && (await checkWalletRateLimit(`auth-challenge-ip:${ip}`, CHALLENGE_IP_LIMIT))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (await checkWalletRateLimit(`auth-challenge:${address}`, WALLET_BURST_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const challenge = await issueSignInChallenge(address);
  const offer = fields.payoutSetup === true ? await payoutSetupOffer(address) : null;
  return NextResponse.json({
    nonce: challenge.nonce,
    message: challenge.message,
    expiresAt: challenge.expiresAt.toISOString(),
    ...(offer && {
      sponsorship: {
        xdr: offer.xdr,
        kind: offer.kind,
        offer: offer.offer,
        expiresAt: offer.expiresAt.toISOString(),
      },
    }),
  });
}

/**
 * The sponsored-trustline envelope `address` will need once signed in, or null
 * when it needs none or none can be offered.
 *
 * Safe before sign-in because the envelope carries no sponsor signature, so
 * nothing handed out here can be broadcast: the sponsor signs only in
 * `POST /api/me/wallet/sponsor`, behind the session and #330's gate
 * (buildSponsorshipOffer). The checks here only avoid asking for a signature
 * that would go unused.
 *
 * Best effort, and bounded by {@link PAYOUT_SETUP_OFFER_DEADLINE_MS}. Sign-in
 * must never wait long on or fail for payout setup, which runs again after
 * sign-in and builds its own envelope when this one is missing. Work that
 * outlives the deadline is abandoned: it only reads, and builds an envelope
 * nobody can broadcast.
 */
async function payoutSetupOffer(address: string): Promise<SponsorshipOffer | null> {
  try {
    return await withDeadline(
      "sign-in sponsorship offer",
      (async () => {
        if (await accountHasUsdcTrustline(address)) return null;
        if (await livePendingSponsorship(address)) return null;
        return buildSponsorshipOffer(address);
      })(),
      PAYOUT_SETUP_OFFER_DEADLINE_MS,
    );
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "sign-in-sponsorship-offer", address } });
    return null;
  }
}
