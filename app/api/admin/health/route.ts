import { NextResponse } from "next/server";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { getHealthSnapshot, isStuckPending } from "@/lib/admin-data";

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const snapshot = await getHealthSnapshot();
  const stuck = snapshot.pendingOldestAt
    ? isStuckPending(snapshot.pendingOldestAt)
    : false;

  return NextResponse.json({
    ...snapshot,
    pendingOldestAt: snapshot.pendingOldestAt?.toISOString() ?? null,
    hasStuckPending: stuck,
  });
}
