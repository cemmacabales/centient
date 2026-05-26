import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

export async function POST(
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
    select: { isVerified: true },
  });

  if (!customer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (customer.isVerified) {
    return NextResponse.json({ error: "already_verified" }, { status: 400 });
  }

  await prisma.adminUser.update({
    where: { id },
    data: {
      isVerified: true,
      verifiedAt: new Date(),
      verificationToken: null,
      verificationTokenExpires: null,
    },
  });

  return NextResponse.json({ ok: true });
}
