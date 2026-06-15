import { NextResponse, NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { auditLog } from "@/lib/audit";

export async function POST(
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

  const customer = await prisma.adminUser.findFirst({
    where: { id, role: "CUSTOMER" },
    select: { isVerified: true, email: true, companyName: true },
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

  auditLog({
    adminUserId: session.sub,
    action: "customer.verify",
    targetType: "adminUser",
    targetId: id,
    req,
    metadata: { email: customer.email, companyName: customer.companyName },
  });

  return NextResponse.json({ ok: true });
}
