import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { prompt, responseA, responseB, disabled } = body;

  if (prompt === undefined && responseA === undefined && responseB === undefined && disabled === undefined) {
    return NextResponse.json({ error: "no_fields_to_update" }, { status: 400 });
  }

  // Validate types and cap field lengths so oversized/invalid payloads can't be
  // written to the DB. Prompt must be a non-empty string (matching the task
  // create convention); responses may be empty but are length-capped.
  const MAX_FIELD_LEN = 10_000;
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_FIELD_LEN)) {
    return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });
  }
  if (responseA !== undefined && (typeof responseA !== "string" || responseA.length > MAX_FIELD_LEN)) {
    return NextResponse.json({ error: "invalid_response_a" }, { status: 400 });
  }
  if (responseB !== undefined && (typeof responseB !== "string" || responseB.length > MAX_FIELD_LEN)) {
    return NextResponse.json({ error: "invalid_response_b" }, { status: 400 });
  }
  if (disabled !== undefined && typeof disabled !== "boolean") {
    return NextResponse.json({ error: "invalid_disabled" }, { status: 400 });
  }

  const existing = await prisma.task.findUnique({
    where: { id },
    select: { prompt: true, responseA: true, responseB: true, disabled: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = await prisma.task.update({
    where: { id },
    data: {
      ...(prompt !== undefined && { prompt }),
      ...(responseA !== undefined && { responseA }),
      ...(responseB !== undefined && { responseB }),
      ...(disabled !== undefined && { disabled }),
    },
    // Return only the fields the admin UI needs, so unrelated columns added to
    // Task later are not inadvertently exposed to the client.
    select: { id: true, prompt: true, responseA: true, responseB: true, disabled: true },
  });

  const changes: Record<string, { old: any; new: any }> = {};
  if (prompt !== undefined && prompt !== existing.prompt) changes.prompt = { old: existing.prompt, new: prompt };
  if (responseA !== undefined && responseA !== existing.responseA) changes.responseA = { old: existing.responseA, new: responseA };
  if (responseB !== undefined && responseB !== existing.responseB) changes.responseB = { old: existing.responseB, new: responseB };
  if (disabled !== undefined && disabled !== existing.disabled) changes.disabled = { old: existing.disabled, new: disabled };

  if (Object.keys(changes).length > 0) {
    auditLog({
      adminUserId: session.sub,
      action: "task.update",
      targetType: "task",
      targetId: updated.id,
      req,
      metadata: { changes },
    });
  }

  return NextResponse.json(updated);
}
