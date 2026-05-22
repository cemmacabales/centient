import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { sendVerificationEmail } from "@/lib/email";
import { randomBytes } from "crypto";

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
    select: { email: true, companyName: true, isVerified: true },
  });

  if (!customer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (customer.isVerified) {
    return NextResponse.json({ error: "already_verified" }, { status: 400 });
  }

  const verificationToken = randomBytes(32).toString("hex");
  await prisma.adminUser.update({
    where: { id },
    data: {
      verificationToken,
      verificationTokenExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  let emailDelivered = true;
  let warning: string | undefined;

  try {
    const result = await sendVerificationEmail(customer.email, verificationToken, customer.companyName ?? undefined);
    if (!result) {
      emailDelivered = false;
      warning = "Verification email could not be sent. Verify that RESEND_EMAIL_FROM is set to a verified domain in Resend.";
    }
  } catch {
    emailDelivered = false;
    warning = "Verification email could not be sent. Verify that RESEND_EMAIL_FROM is set to a verified domain in Resend.";
  }

  return NextResponse.json({ emailDelivered, warning });
}
