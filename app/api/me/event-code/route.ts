import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";
import { redeemEventCode, type RedeemError } from "@/lib/gamification/redeem";

// #203: redeem an event code from a booth or a webinar for its stamp and 25 XP.
// The rules live in lib/gamification/redeem.ts.

const STATUS: Record<RedeemError, number> = {
  wallet_required: 409,
  banned: 403,
  rate_limited: 429,
  unknown_code: 404,
  not_open: 409,
  ended: 409,
  already_redeemed: 409,
};

export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const result = await redeemEventCode(userId, body?.code);
  if (!result) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!result.ok) {
    const headers = result.error === "rate_limited" ? { "Retry-After": String(result.retryAfterSeconds) } : undefined;
    return NextResponse.json({ error: result.error }, { status: STATUS[result.error], headers });
  }
  const { ok: _ok, ...redeemed } = result;
  return NextResponse.json(redeemed);
}
