import { NextRequest, NextResponse } from "next/server";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { issueSignInChallenge } from "@/lib/stellar/auth-challenge";
import { checkWalletRateLimit, WALLET_BURST_LIMIT, type RateLimit } from "@/lib/rate-limit";

/** Per IP: wider than per address, since contributors behind one NAT share it. */
export const CHALLENGE_IP_LIMIT: RateLimit = { max: 20, windowMs: 60_000 };

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
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const address =
    body && typeof body === "object" && typeof (body as { address?: unknown }).address === "string"
      ? (body as { address: string }).address
      : "";

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
  return NextResponse.json({
    nonce: challenge.nonce,
    message: challenge.message,
    expiresAt: challenge.expiresAt.toISOString(),
  });
}
