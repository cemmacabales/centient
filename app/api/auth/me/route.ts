import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";

export async function GET(req: NextRequest) {
  const wallet = await getLabelerSession(req);
  if (!wallet) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({ authenticated: true, wallet });
}
