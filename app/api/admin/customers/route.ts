import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { verifyDomainExists } from "@/lib/email-validation";
import { sendVerificationEmail } from "@/lib/email";
import { randomBytes } from "crypto";
function isValidPassword(password: string): boolean{
  if (password.length < 8 || password.length >= 128) return false;
  if (!/\d/.test(password)) return false;
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return false;
  return true;
}
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
      isVerified: true,
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
  if (!isValidPassword(password)){
    return NextResponse.json({ error: "weak_password" }, {status: 400})
  }
  const normalizedEmail = email.toLowerCase().trim();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(normalizedEmail)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  const domain = normalizedEmail.split("@")[1];
  const domainValid = await verifyDomainExists(domain);

  const existing = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
  if (!domainValid){
    return NextResponse.json({ error: "invalid_domain"}, {status: 400});
  }
  if (existing) {
    return NextResponse.json({ error: "email_exists" }, { status: 409 });
  }
  const verificationToken = randomBytes(32).toString("hex");
  console.log("[customer-create] Creating customer:", { email: normalizedEmail, tokenLength: verificationToken.length });
  const customer = await prisma.adminUser.create({
    data: {
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role: "CUSTOMER",
      companyName: companyName || null,
      isVerified: false,
      verificationToken,
      verificationTokenExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    select: {
      id: true,
      email: true,
      companyName: true,
      createdAt: true,
    },
  });
  sendVerificationEmail(normalizedEmail, verificationToken, companyName).catch(console.error);
  console.log("[customer-create] Customer created with verification token. Token expiry:", new Date(Date.now() + 24 * 60 * 60 * 1000));
  return NextResponse.json(customer, { status: 201 });
}
