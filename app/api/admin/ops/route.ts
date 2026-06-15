import { NextResponse } from "next/server";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { getOpsDashboardData } from "@/lib/admin-data";

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const data = await getOpsDashboardData();
  return NextResponse.json(data);
}
