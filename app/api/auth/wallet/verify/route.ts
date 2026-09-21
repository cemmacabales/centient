import { NextRequest, NextResponse } from "next/server";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { consumeSignInChallenge, findOrCreateWalletUser } from "@/lib/stellar/auth-challenge";
import { setLabelerSessionCookie, signLabelerJWT } from "@/lib/labeler-auth";

/**
 * POST /api/auth/wallet/verify — sign in by proving control of a Stellar address (#25).
 *
 * Body: `{ address, nonce, signature, signerAddress? }`, where `signature` is
 * Freighter's SEP-53 `signMessage` result (base64) over the challenge from
 * `/api/auth/wallet/challenge`, and `signerAddress` is the signer Freighter
 * reported.
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
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { address, nonce, signature, signerAddress } = body as Record<string, unknown>;
  if (
    typeof nonce !== "string" ||
    !nonce ||
    typeof signature !== "string" ||
    !signature ||
    (signerAddress !== undefined && typeof signerAddress !== "string")
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
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 401 });
  }

  const user = await findOrCreateWalletUser(result.address);
  const token = await signLabelerJWT(user.id);
  const res = NextResponse.json({
    success: true,
    userId: user.id,
    walletAddress: result.address,
    created: user.created,
  });
  return setLabelerSessionCookie(res, token);
}
