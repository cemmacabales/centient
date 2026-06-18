import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import prisma from "@/lib/prisma";
import { isValidEmail, isValidPassword } from "@/lib/validation";
import { sendVerificationEmail } from "@/lib/email";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Identical response for both new and already-registered emails so the endpoint
// cannot be used to enumerate which addresses have accounts. A returning user
// who already has an account simply sees this and recognizes it; a genuinely new
// user receives the verification email.
const GENERIC_RESPONSE = {
  message: "If that email is new, check your inbox for a verification link.",
} as const;

/**
 * POST /api/auth/register — labeler email/password registration.
 *
 * Mirrors the AdminUser hashing pattern (bcrypt cost 12) and reuses the existing
 * verify-email flow: a verification token is stored on the User and emailed; the
 * user confirms via /api/verify-email before they can log in.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { email, password } = body as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (!isValidEmail(normalizedEmail)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (!isValidPassword(password)) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    // Do not reveal that the account already exists — return the same response
    // as a successful new registration.
    return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
  }

  const verificationToken = randomBytes(32).toString("hex");
  await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      isVerified: false,
      verificationToken,
      verificationTokenExpires: new Date(Date.now() + VERIFICATION_TTL_MS),
    },
    select: { id: true },
  });

  // Delivery failures are logged inside sendVerificationEmail; we intentionally
  // return the same generic response regardless so the outcome cannot be used to
  // distinguish a new email from an existing one.
  try {
    await sendVerificationEmail(normalizedEmail, verificationToken);
  } catch {
    // already logged in lib/email
  }

  return NextResponse.json(GENERIC_RESPONSE, { status: 200 });
}
