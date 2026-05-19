import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
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