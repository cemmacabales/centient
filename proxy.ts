import { NextRequest, NextResponse } from "next/server";
import { verifyAdminJWT } from "@/lib/admin-auth";

const PUBLIC_PATHS = ["/admin/login", "/api/admin/login", "/api/admin/logout"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only intercept /admin/** routes
  if (!pathname.startsWith("/admin") && !pathname.startsWith("/api/admin")) {
    return NextResponse.next();
  }

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Verify JWT from cookie
  const token = req.cookies.get("admin_session")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/admin/login", req.url));
  }

  const payload = await verifyAdminJWT(token);
  if (!payload) {
    const res = NextResponse.redirect(new URL("/admin/login", req.url));
    res.cookies.delete("admin_session");
    return res;
  }

  // Pass payload info to route handlers via headers
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-admin-id", payload.sub as string);
  requestHeaders.set("x-admin-email", payload.email);
  requestHeaders.set("x-admin-role", payload.role);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
