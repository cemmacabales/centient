import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { signLabelerJWT, setLabelerSessionCookie } from "@/lib/labeler-auth";
import {
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginFailures,
} from "@/lib/rate-limit";

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * POST /api/auth/login — labeler email/password login.
 *
 * Verifies the bcrypt hash and issues the same userId-keyed session as wallet
 * sign-in. Failures return a generic `invalid_credentials` to avoid account
 * enumeration; the password is checked before the verification state so that an
 * unverified account is only revealed to someone who knows the correct password.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (await isLoginRateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { email, password } = body as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    await recordLoginFailure(ip);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!user || !user.passwordHash) {
    await recordLoginFailure(ip);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordLoginFailure(ip);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  if (!user.isVerified) {
    return NextResponse.json({ error: "email_not_verified" }, { status: 403 });
  }

  await resetLoginFailures(ip);
  const token = await signLabelerJWT(user.id);
  const res = NextResponse.json({ success: true, userId: user.id });
  return setLabelerSessionCookie(res, token);
}
