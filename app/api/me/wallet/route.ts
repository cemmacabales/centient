import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import { isValidStellarAddress, verify } from "@/lib/stellar/signature";
import { checkWalletRateLimit, WALLET_BURST_LIMIT } from "@/lib/rate-limit";
import { WALLET_LINK_ACTION } from "@/lib/stellar/challenge-message";
import { takeOverUnusedWalletAccount } from "@/lib/stellar/auth-challenge";

/**
 * ST-4b (#300) — prove a Stellar `G…` address and bind it to the session's account.
 *
 *   GET  → issue a one-time challenge for a candidate `G…` (replay-protected via
 *          the existing WalletNonce table, 5-min TTL).
 *   POST → verify the SEP-53 signature over that challenge (ST-4a `verify`), then
 *          bind the address to the account.
 *
 * #30 — this is the claim path for an account created by email before wallet
 * sign-in. A contributor normally signs in with the wallet itself
 * (`/api/auth/wallet/verify`), which makes the proven address the account. The
 * bound address is the account's identity and its payout destination, so:
 *
 * - It binds before any sponsorship, with no USDC-trustline precheck. The payout
 *   setup that follows sponsors the bound wallet only, so a sponsored address
 *   always belongs to an account (#29: that is what protects it from reclaim).
 * - An account keeps the wallet it has. Proving the same address again succeeds;
 *   a different Stellar address is refused, not swapped in. A legacy EVM `0x…`
 *   value, which can never receive USDC, may be replaced.
 *
 * StrKey is case-sensitive base32 — the address is never lowercased/normalized.
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

/** Persist one live payout-link challenge, reusing the winner of an issuance race. */
async function issueWalletLinkChallenge(address: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date();
    const nonce = randomUUID().replace(/-/g, "");
    const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);

    await prisma.walletNonce.deleteMany({
      where: { walletAddress: address, action: WALLET_LINK_ACTION, expiresAt: { lte: now } },
    });

    try {
      await prisma.walletNonce.create({
        data: { walletAddress: address, action: WALLET_LINK_ACTION, nonce, expiresAt },
      });
      return nonce;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const readAt = new Date();
      const committed = await prisma.walletNonce.findFirst({
        where: { walletAddress: address, action: WALLET_LINK_ACTION, expiresAt: { gt: readAt } },
      });
      if (committed) return committed.nonce;
      if (attempt === 1) throw err;
    }
  }

  throw new Error("issueWalletLinkChallenge: unreachable");
}

/** Issue or reuse the authenticated contributor's live payout-link challenge. */
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

  // Throttle challenge issuance per candidate address. A live row is reused,
  // but an unthrottled caller could still churn expiry checks and replacement
  // writes. Distinct from the sponsor-build key so the two flows do not collide.
  // A small burst, so a declined Freighter prompt can be retried straight away.
  if (await checkWalletRateLimit(`link:${address}`, WALLET_BURST_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Scoped to this flow: the same address may hold a pending wallet sign-in
  // challenge (#25), which a link request must not delete. A live challenge is
  // reused when another request wins the unique-constraint race.
  const nonce = await issueWalletLinkChallenge(address);

  return NextResponse.json({ message: buildWalletLinkMessage(address, nonce), nonce });
}

/** Verify and consume a payout-link proof, then bind its address to the session user. */
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
    where: { walletAddress: stellarAddress, action: WALLET_LINK_ACTION, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!nonceRow) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
  }

  const message = buildWalletLinkMessage(stellarAddress, nonceRow.nonce);
  if (!verify(stellarAddress, message, signature)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Claim only the proof that was verified, while it is still live. If expiry
  // or a concurrent request removed it, this proof no longer grants access and
  // must not consume a replacement challenge for the same address.
  const consumed = await prisma.walletNonce.deleteMany({
    where: {
      nonce: nonceRow.nonce,
      walletAddress: stellarAddress,
      action: WALLET_LINK_ACTION,
      expiresAt: { gt: new Date() },
    },
  });
  if (consumed.count === 0) {
    return NextResponse.json({ error: "challenge_expired" }, { status: 400 });
  }

  // `User.walletAddress` is `@unique`. If this `G…` is already the wallet of a
  // *different* account (a second/sybil account, a shared wallet, or a
  // re-registration), the write throws P2002. Return a clean 409 instead of a
  // raw 500 — same pattern as enqueueWithdrawal's unique-index handling —
  // unless that account is the empty one a wallet sign-in created by accident
  // before this email account claimed the wallet: then the proof just verified
  // lets this account take the address over.
  let bound: { count: number };
  try {
    // Conditional, so two concurrent proofs cannot both bind: only an account
    // with no usable wallet takes one.
    bound = await prisma.user.updateMany({
      where: { id: userId!, OR: [{ walletAddress: null }, { walletAddress: { startsWith: "0x" } }] },
      data: { walletAddress: stellarAddress },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      if (await takeOverUnusedWalletAccount(stellarAddress, userId!)) {
        return NextResponse.json({ linked: true, walletAddress: stellarAddress });
      }
      return NextResponse.json({ error: "address_already_linked" }, { status: 409 });
    }
    throw err;
  }

  if (bound.count === 0) {
    const current = await prisma.user.findUnique({
      where: { id: userId! },
      select: { walletAddress: true },
    });
    if (!current) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (current.walletAddress !== stellarAddress) {
      return NextResponse.json({ error: "wallet_already_bound" }, { status: 409 });
    }
  }

  return NextResponse.json({ linked: true, walletAddress: stellarAddress });
}
