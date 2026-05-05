import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin-auth";

function externalOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
    req.headers.get("host");
  if (proto && host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  const email = session.email;
  session.destroy();
  console.info("[admin] logout", { email });
  return NextResponse.redirect(new URL("/admin/login", externalOrigin(req)), 303);
}
