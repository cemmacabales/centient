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

/**
 * Set the session cookie.
 *
 * `embedded` is for a session started inside Lantern, whose Apps tab frames
 * this app from another site: there a `Lax` cookie is never sent, so the
 * contributor would be signed out on their next request. Instead the cookie is
 * `SameSite=None` and **partitioned** (CHIPS) — kept under Lantern's top-level
 * site, so it is sent inside Lantern's frame and nowhere else. A page on some
 * other site that frames or posts to Centient reads its own, empty partition,
 * so the cookie still never rides along on a request another site starts.
 */
export async function setLabelerSessionCookie(
  res: NextResponse,
  token: string,
  { embedded = false }: { embedded?: boolean } = {}
): Promise<NextResponse> {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
    ...(embedded
      ? { secure: true, sameSite: "none", partitioned: true }
      : { secure: process.env.NODE_ENV === "production", sameSite: "lax" }),
  });
  return res;
}

/**
 * Expire the session cookie. A partitioned cookie is a separate cookie, deleted
 * only by a `Set-Cookie` that is partitioned too, so both are expired: one
 * response, whichever kind this browser holds.
 */
export function clearLabelerSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0, // expire immediately
    path: "/",
  });
  // Appended after `cookies.set`, which rewrites every Set-Cookie it knows of
  // and holds one per name.
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`,
  );
  return res;
}

export function requireLabelerSession(
  userId: string | null
): void | NextResponse {
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
