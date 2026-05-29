import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { AdminRole } from "@/app/generated/prisma/client";
import { NextResponse } from "next/server";

const COOKIE_NAME = "admin_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export interface AdminJWTPayload extends JWTPayload {
  sub: string; // adminUserId
  email: string;
  role: AdminRole;
  companyName: string | null;
}

function getJwtSecret(): Uint8Array {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ADMIN_JWT_SECRET must be set and at least 32 characters long");
  }
  return new TextEncoder().encode(secret);
}

export async function signAdminJWT(payload: Omit<AdminJWTPayload, keyof JWTPayload>): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret());
}

export async function verifyAdminJWT(token: string): Promise<AdminJWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as AdminJWTPayload;
  } catch {
    return null;
  }
}

export async function getAdminSession(): Promise<AdminJWTPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyAdminJWT(token);
}

export async function setAdminSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

export async function clearAdminSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function requireAdmin(): Promise<AdminJWTPayload> {
  const session = await getAdminSession();
  if (!session) redirect("/admin/login");
  return session;
}

// For use in route handlers (API routes)
export async function requireRoleForRoute(
  role: AdminRole,
  session: AdminJWTPayload
): Promise<void | NextResponse> {
  if (session.role !== role) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
}

// For use in server components/pages
export async function requireRoleForPage(role: AdminRole): Promise<AdminJWTPayload> {
  const session = await requireAdmin();
  if (session.role !== role) {
    redirect("/admin/login");
  }
  return session;
}

// Authorization seam for export endpoints — placeholder for payment/billing gate.
// Currently a no-op: authorization is enforced by the WHERE clause in the DB query.
// The campaignId parameter is reserved for future per-campaign entitlement checks
// (e.g., verifying the customer has export credits for a specific campaign).
export function assertExportAllowed(session: AdminJWTPayload, campaignId: string): void {
  // Authorization handled at DB query level — no IDOR risk here.
  // TODO: add async billing/entitlement check before allowing export:
  // e.g.: if (!await hasExportEntitlement(session.sub, campaignId)) throw new Error("export_not_allowed");
}
