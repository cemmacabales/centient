import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";
import { hideDisplayName } from "@/lib/gamification/profile";

// #203: hide a labeler's board name. It shows as "Hidden labeler", the name is
// retired, and the labeler is asked to choose another. Every hide is logged.
export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => null);
  const userId = typeof body?.userId === "string" ? body.userId : null;
  if (!userId) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const hidden = await hideDisplayName(userId);
  if (!hidden) {
    return NextResponse.json({ error: "no_name" }, { status: 404 });
  }

  auditLog({
    adminUserId: session.sub,
    action: "displayName.hide",
    targetType: "user",
    targetId: userId,
    metadata: { name: hidden.name },
    req,
  });
  return NextResponse.json({ hidden: true });
}
