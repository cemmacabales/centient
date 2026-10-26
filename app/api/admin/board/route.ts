import { NextResponse } from "next/server";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { readAdminBoard } from "@/lib/gamification/leaderboard";

// #203: this week's board for the admin's Weekly board panel (board 10).
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  return NextResponse.json(await readAdminBoard());
}
