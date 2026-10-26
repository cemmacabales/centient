import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";
import { validateEventCode } from "@/lib/gamification/events";
import { createEventCode, listEventCodes } from "@/lib/gamification/redeem";

// #203: event codes for booths and webinars (board 10). Super admins only; the
// gamification tab shows whatever NEXT_PUBLIC_GAMIFICATION says, so a code can
// be made before the labeler UI turns on.

async function superAdmin() {
  const session = await getAdminSession();
  if (!session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return { error: forbidden };
  return { session };
}

export async function GET() {
  const auth = await superAdmin();
  if (auth.error) return auth.error;
  return NextResponse.json({ codes: await listEventCodes() });
}

export async function POST(req: NextRequest) {
  const auth = await superAdmin();
  if (auth.error) return auth.error;

  const checked = validateEventCode(await req.json().catch(() => null));
  if (!checked.ok) {
    return NextResponse.json({ error: "invalid", field: checked.field }, { status: 400 });
  }
  const created = await createEventCode(auth.session.sub, checked.value);
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: 409 });
  }

  const { code, stampTitle, stampIcon, startsDay, endsDay } = checked.value;
  auditLog({
    adminUserId: auth.session.sub,
    action: "eventCode.create",
    targetType: "eventCode",
    targetId: created.code.id,
    metadata: { code, stampTitle, stampIcon, startsDay, endsDay },
    req,
  });
  return NextResponse.json(
    { id: created.code.id, code, stampTitle, stampIcon, startsDay, endsDay, redeemed: 0 },
    { status: 201 },
  );
}
