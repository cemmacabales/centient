import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import { isValidStellarAddress, verify } from "@/lib/stellar/signature";
import { accountHasUsdcTrustline } from "@/lib/stellar/client";
import { checkWalletRateLimit } from "@/lib/rate-limit";

/**
 * ST-4b (#300) — link + prove a Stellar `G…` payout address.
 *
 * Login stays email/password; a Stellar wallet (Freighter) is used ONLY here, to
 * link and cryptographically prove ownership of the withdrawal destination:
 *
 *   GET  → issue a one-time challenge for a candidate `G…` (replay-protected via
 *          the existing WalletNonce table, 5-min TTL).
 *   POST → verify the SEP-53 signature over that challenge (ST-4a `verify`),
 *          precheck the USDC trustline, then bind the address to the account.
 *
 * StrKey is case-sensitive base32 — the address is never lowercased/normalized
 * (carry this rule into ST-4d). The trustline precheck rejects an untrusted
 * address with clear guidance instead of letting the payout fail silently with
 * `op_no_trust`; ST-4e (#314) replaces the reject with a sponsored-trustline flow.
 */

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Deterministic challenge text bound to the address + nonce; signed by the wallet. */
export function buildWalletLinkMessage(address: string, nonce: string): string {
  return [
    "Instawards: link this Stellar address as your USDC payout destination.",
    "",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const address = req.nextUrl.searchParams.get("address");
  // No normalization: StrKey is case-sensitive; a lowercased `G…` is a different
  // (invalid) key and must be rejected, not silently mangled.
  if (!address || !isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  // Throttle challenge issuance per candidate address: each GET prunes the prior
  // nonce and writes a new one, so an unthrottled loop would churn Prisma
  // transactions. Same per-wallet limiter the submit path uses.
  if (await checkWalletRateLimit(address)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const nonce = randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await prisma.$transaction([
    prisma.walletNonce.deleteMany({ where: { walletAddress: address } }),
    prisma.walletNonce.create({ data: { walletAddress: address, nonce, expiresAt } }),
  ]);

  return NextResponse.json({ message: buildWalletLinkMessage(address, nonce), nonce });
}

export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  let body: { stellarAddress?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const stellarAddress = typeof body.stellarAddress === "string" ? body.stellarAddress : "";
  const signature = typeof body.signature === "string" ? body.signature : "";

  if (!isValidStellarAddress(stellarAddress)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  if (!signature) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Look up the most recent unexpired challenge for this exact address.
  const nonceRow = await prisma.walletNonce.findFirst({
    where: { walletAddress: stellarAddress, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!nonceRow) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
  }

  const message = buildWalletLinkMessage(stellarAddress, nonceRow.nonce);
  if (!verify(stellarAddress, message, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // One-time use: consume every challenge for this address regardless of outcome.
  await prisma.walletNonce.deleteMany({ where: { walletAddress: stellarAddress } });

  // USDC-trustline precheck — an untrusted `G…` would fail the payout with a
  // silent `op_no_trust`. Reject up front with guidance instead. (ST-4e turns
  // this into an in-app sponsored-trustline flow.)
  let hasTrustline: boolean;
  try {
    hasTrustline = await accountHasUsdcTrustline(stellarAddress);
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "wallet-link-trustline", userId } });
    return NextResponse.json({ error: "trustline_check_failed" }, { status: 502 });
  }
  if (!hasTrustline) {
    return NextResponse.json(
      {
        error: "no_trustline",
        message:
          "This Stellar address has no USDC trustline yet. Add a USDC trustline in your wallet, then link again.",
      },
      { status: 409 },
    );
  }

  // `User.walletAddress` is `@unique`. If this `G…` is already the payout
  // destination of a *different* account (a second/sybil account, a shared
  // wallet, or a re-registration), the update throws P2002. Return a clean 409
  // instead of a raw 500 — same pattern as enqueueWithdrawal's unique-index handling.
  try {
    await prisma.user.update({
      where: { id: userId! },
      data: { walletAddress: stellarAddress },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "address_already_linked" }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ linked: true, walletAddress: stellarAddress });
}
