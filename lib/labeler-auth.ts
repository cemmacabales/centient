import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "labeler_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export interface LabelerJWTPayload extends JWTPayload {
  sub: string; // walletAddress
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

export async function signLabelerJWT(walletAddress: string): Promise<string> {
  return new SignJWT({ sub: walletAddress.toLowerCase() })
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

export async function getLabelerSession(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifyLabelerJWT(token);
  return payload?.sub ?? null;
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
  walletAddress: string | null
): void | NextResponse {
  if (!walletAddress) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
