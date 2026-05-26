import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id, taskId } = await params;

  const where = session.role === "SUPER_ADMIN" ? { id } : { id, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: { id: true, defaultResponseTarget: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await req.json();
  const { prompt, responseTarget } = body;

  if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim().length === 0)) {
    return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });
  }

  if (responseTarget !== undefined) {
    if (!Number.isInteger(responseTarget) || responseTarget < 1) {
      return NextResponse.json({ error: "invalid_response_target" }, { status: 400 });
    }
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, campaignId: id },
  });

  if (!task) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: {
      ...(prompt !== undefined ? { prompt: prompt.trim() } : {}),
      ...(responseTarget !== undefined ? { responseTarget } : {}),
    },
  });

  return NextResponse.json({
    taskId: updated.id,
    prompt: updated.prompt,
    responseTarget: updated.responseTarget ?? campaign.defaultResponseTarget,
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id, taskId } = await params;

  const where = session.role === "SUPER_ADMIN" ? { id } : { id, adminUserId: session.sub };

  const campaign = await prisma.campaign.findFirst({
    where,
    select: { id: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, campaignId: id },
  });

  if (!task) {
    return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  }

  await prisma.task.delete({ where: { id: taskId } });

  return NextResponse.json({ success: true });
}
