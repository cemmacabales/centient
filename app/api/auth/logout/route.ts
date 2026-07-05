import { NextRequest, NextResponse } from "next/server";
import { clearLabelerSessionCookie } from "@/lib/labeler-auth";

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  clearLabelerSessionCookie(res);
  console.info("[labeler] logout");
  return res;
}
