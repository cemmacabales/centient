import { NextResponse } from "next/server";

/**
 * POST /api/auth/register — retired (#30).
 *
 * A contributor's account is the Stellar wallet they prove at sign-in
 * (`/api/auth/wallet/verify`), so no new email/password account is created. An
 * account made by email before wallet sign-in can still sign in through
 * `/api/auth/login`, but it must bind a wallet (`/api/me/wallet`) before it can
 * earn or withdraw. 410 tells a stale client the route is gone for good.
 */
export async function POST() {
  return NextResponse.json({ error: "email_registration_retired" }, { status: 410 });
}
