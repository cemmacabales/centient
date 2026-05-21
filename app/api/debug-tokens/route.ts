import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

export async function GET() {
  const session = await getAdminSession();
  if (!session){
    return NextResponse.json({ error: "unauthorized"}, {status: 401});
  }
  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;
  const customers = await prisma.adminUser.findMany({
    where: { role: "CUSTOMER" },
    select: {
      id: true,
      email: true,
      isVerified: true,
      verificationToken: true,
      verificationTokenExpires: true,
      verifiedAt: true,
    },
  });

  return NextResponse.json({
    customers: customers.map(c => ({
      ...c,
      // Don't expose full token in response, just show length
      tokenLength: c.verificationToken?.length || 0,
      verificationToken: c.verificationToken ? "***" + c.verificationToken.slice(-8) : null,
    })),
  });
}