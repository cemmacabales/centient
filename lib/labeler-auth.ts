import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

const COOKIE_NAME = "labeler_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export interface LabelerJWTPayload extends JWTPayload {
  sub: string; // User.id
}

/**
 * The resolved labeler identity behind a session. `walletAddress` is null for
 * email/password accounts that have not linked a wallet yet.
 */
export interface LabelerUser {
  id: string;
  walletAddress: string | null;
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.LABELER_JWT_SECRET ?? process.env.ADMIN_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "LABELER_JWT_SECRET (or fallback ADMIN_JWT_SECRET) must be set and at least 32 characters long"
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signLabelerJWT(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret());
}

export async function verifyLabelerJWT(token: string): Promise<LabelerJWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as LabelerJWTPayload;
  } catch {
    return null;
  }
}

/**
 * Returns the authenticated `User.id` from the session cookie, or null.
 */
export async function getLabelerSession(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifyLabelerJWT(token);
  return payload?.sub ?? null;
}

/**
 * Resolves the session to the underlying user record (id + linked wallet).
 * Returns null when there is no valid session or the user no longer exists.
 */
export async function getLabelerUser(req: NextRequest): Promise<LabelerUser | null> {
  const userId = await getLabelerSession(req);
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, walletAddress: true },
  });
}

export async function setLabelerSessionCookie(
  res: NextResponse,
  token: string
): Promise<NextResponse> {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}

export function requireLabelerSession(
  userId: string | null
): void | NextResponse {
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
