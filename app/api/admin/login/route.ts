import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { signAdminJWT, setAdminSessionCookie } from "@/lib/admin-auth";
import {
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginFailures,
} from "@/lib/admin-rate-limit";

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function externalOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
    req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

function redirectToLogin(req: NextRequest, error: string) {
  const url = new URL("/admin/login", externalOrigin(req));
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (isLoginRateLimited(ip)) {
    console.warn("[admin] login_rate_limited", { ip });
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const form = await req.formData();
  const email = (form.get("email") ?? "").toString().trim().toLowerCase();
  const password = (form.get("password") ?? "").toString();

  if (!email || !password) {
    recordLoginFailure(ip);
    console.warn("[admin] login_fail", { ip, email, reason: "missing_fields" });
    return redirectToLogin(req, "invalid");
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) {
    recordLoginFailure(ip);
    console.warn("[admin] login_fail", { ip, email, reason: "unknown_user" });
    return redirectToLogin(req, "invalid");
  }

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) {
    recordLoginFailure(ip);
    console.warn("[admin] login_fail", { ip, email, reason: "bad_password" });
    return redirectToLogin(req, "invalid");
  }

  const token = await signAdminJWT({
    sub: admin.id,
    email: admin.email,
    role: admin.role,
    companyName: admin.companyName ?? null,
  });

  await setAdminSessionCookie(token);
  resetLoginFailures(ip);
  console.info("[admin] login_ok", { ip, email });

  return NextResponse.redirect(new URL("/admin", externalOrigin(req)), 303);
}
