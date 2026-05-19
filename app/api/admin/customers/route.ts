import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const customers = await prisma.adminUser.findMany({
    where: { role: "CUSTOMER" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      companyName: true,
      createdAt: true,
    },
  });

  return NextResponse.json(customers);
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const { email, password, companyName } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return NextResponse.json({ error: "email_exists" }, { status: 409 });
  }

  const customer = await prisma.adminUser.create({
    data: {
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role: "CUSTOMER",
      companyName: companyName || null,
    },
    select: {
      id: true,
      email: true,
      companyName: true,
      createdAt: true,
    },
  });

  return NextResponse.json(customer, { status: 201 });
}
