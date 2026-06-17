import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import prisma from "@/lib/prisma";
import { isValidEmail, isValidPassword } from "@/lib/validation";
import { sendVerificationEmail } from "@/lib/email";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    return NextResponse.json({ error: "email_exists" }, { status: 409 });
  }

  const verificationToken = randomBytes(32).toString("hex");
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      isVerified: false,
      verificationToken,
      verificationTokenExpires: new Date(Date.now() + VERIFICATION_TTL_MS),
    },
    select: { id: true, email: true, isVerified: true },
  });

  let emailDelivered = true;
  let warning: string | undefined;
  try {
    const result = await sendVerificationEmail(normalizedEmail, verificationToken);
    if (!result) {
      emailDelivered = false;
      warning =
        "Account created but verification email could not be sent. Verify that RESEND_EMAIL_FROM is set to a verified domain in Resend.";
    }
  } catch {
    emailDelivered = false;
    warning =
      "Account created but verification email could not be sent. Verify that RESEND_EMAIL_FROM is set to a verified domain in Resend.";
  }

  return NextResponse.json({ user, emailDelivered, warning }, { status: 201 });
}
