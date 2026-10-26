import { NextRequest, NextResponse } from "next/server";
import { isValidStellarAddress, parseSignatureScheme } from "@/lib/stellar/signature";
import { consumeSignInChallenge, findOrCreateWalletUser } from "@/lib/stellar/auth-challenge";
import { setLabelerSessionCookie, signLabelerJWT } from "@/lib/labeler-auth";
import { isAnyIdentifierBanned } from "@/lib/ban-identity";
import prisma from "@/lib/prisma";
import { attachInviter } from "@/lib/gamification/invites";
import { INVITE_RULES } from "@/lib/gamification/invite-rules";

/**
 * POST /api/auth/wallet/verify — sign in by proving control of a Stellar address (#25).
 *
 * Body: `{ address, nonce, signature, signerAddress?, scheme?, embedded? }`,
 * where `signature` is the wallet's `signMessage` result (base64) over the
 * challenge from `/api/auth/wallet/challenge`, and `signerAddress` is the signer
 * the wallet reported. `scheme` is how it framed the message: SEP-53 (Freighter,
 * the default) or `lantern`. `embedded` asks for a session cookie that works
 * inside Lantern's frame (see setLabelerSessionCookie).
 *
 * A malformed request is a 400 and leaves the challenge untouched. A refused
 * proof is a 401 and also leaves it: the nonce is not a secret, so consuming it
 * on failure would let anyone fail another contributor's sign-in. Only an
 * accepted proof, or an expired challenge, removes it.
 *
 * Success issues the same userId-keyed `labeler_session` as email login,
 * resolved by the proven address: the contributor holding it, or a new
 * wallet-only one. A request that already carries a session is signed in as the
 * proven address's contributor instead. Linking an address to an email account
 * is still `/api/me/wallet`'s job, not this route's.
 *
 * A contributor banned on any identifier (email, address or account, #36) gets
 * a 403 `banned` and no session. The submit route checks the same, so this only
 * keeps a banned identity out rather than being the guard that stops payment.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { address, nonce, signature, signerAddress, embedded } = body as Record<string, unknown>;
  const scheme = parseSignatureScheme((body as Record<string, unknown>).scheme);
  if (
    typeof nonce !== "string" ||
    !nonce ||
    typeof signature !== "string" ||
    !signature ||
    (signerAddress !== undefined && typeof signerAddress !== "string") ||
    scheme === null
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  // No normalization: StrKey is case-sensitive, so a lowercased key is refused.
  if (typeof address !== "string" || !isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  const result = await consumeSignInChallenge({
    address,
    nonce,
    signature,
    signerAddress: signerAddress as string | undefined,
    scheme,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 401 });
  }

  const user = await findOrCreateWalletUser(result.address);
  const holder = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true } });
  if (await isAnyIdentifierBanned(holder?.email ?? null, result.address, user.id)) {
    return NextResponse.json({ error: "banned" }, { status: 403 });
  }
  // #203: an invite link's cookie names the inviter of an account created just
  // now, never one that existed. Best effort: a bad code never blocks sign-in.
  const invite = req.cookies.get(INVITE_RULES.cookie)?.value;
  if (user.created && invite) {
    await attachInviter(user.id, invite).catch(() => false);
  }
  const token = await signLabelerJWT(user.id);
  const res = NextResponse.json({
    success: true,
    userId: user.id,
    walletAddress: result.address,
    created: user.created,
  });
  if (invite) res.cookies.delete(INVITE_RULES.cookie);
  return setLabelerSessionCookie(res, token, { embedded: embedded === true });
}
