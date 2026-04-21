import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin-auth";

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  const username = session.username;
  session.destroy();
  console.info("[admin] logout", { username });
  return NextResponse.redirect(new URL("/admin/login", req.url), 303);
}
