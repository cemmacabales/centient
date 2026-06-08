import { NextRequest, NextResponse } from "next/server";

export function authenticateCron(req: NextRequest): NextResponse | null {
  const authHeader = req.headers.get("Authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
