import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { verifyDomainExists } from "@/lib/email-validation";
import { sendVerificationEmail } from "@/lib/email";
import { randomBytes } from "crypto";
import { isValidEmail, isValidPassword } from "@/lib/validation";
import { auditLog } from "@/lib/audit";

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
  let emailDelivered = true;
  let warning: string | undefined;
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
  if (!isValidEmail(normalizedEmail)){
    return NextResponse.json({ error: "invalid_email"}, {status: 400});
  }
  const domain = normalizedEmail.split("@")[1];
  const dnsResult = await verifyDomainExists(domain);
  if (dnsResult === "no_mx"){
    return NextResponse.json({ error: "invalid_domain"}, {status: 400});
  }
  if (dnsResult === "error"){
    return NextResponse.json({ error: "dns_check_failed"}, {status: 502});
  }
  const existing = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return NextResponse.json({ error: "email_exists" }, { status: 409 });
  }
  const verificationToken = randomBytes(32).toString("hex");
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
      isVerified: true,
    },
  });

  auditLog({
    adminUserId: session.sub,
    action: "customer.create",
    targetType: "adminUser",
    req,
    metadata: {
      email: customer.email,
      companyName: customer.companyName,
    },
  });
  
  try{
    const result = await sendVerificationEmail(normalizedEmail, verificationToken, companyName);
    if (!result) {
      emailDelivered = false;
      warning = "Customer created but verification email could not be sent. Verify that RESEND_EMAIL_FROM is set to a verified domain in Resend.";
    }
  }
  catch{
      emailDelivered = false;
      warning = "Customer created but verification email could not be sent. Verify that RESEND_EMAIL_FROM is set to a verified domain in Resend.";
    }
  return NextResponse.json({customer, emailDelivered, warning}, { status: 201 });
}
