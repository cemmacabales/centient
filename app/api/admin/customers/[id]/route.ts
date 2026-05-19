import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const { id } = await params;

  const customer = await prisma.adminUser.findFirst({
    where: { id, role: "CUSTOMER" },
  });

  if (!customer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await prisma.adminUser.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
