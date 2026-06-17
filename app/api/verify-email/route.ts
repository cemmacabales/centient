import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

interface VerifiableAccount {
  isVerified: boolean;
  verificationTokenExpires: Date | null;
}

/**
 * Applies the shared verify-email state machine to either an AdminUser or a
 * labeler User record. `clear` wipes the token; `verify` also flips isVerified.
 */
async function resolveVerification(
  account: VerifiableAccount,
  clear: () => Promise<unknown>,
  verify: () => Promise<unknown>,
): Promise<NextResponse> {
  if (account.isVerified) {
    await clear();
    return NextResponse.json({ success: true, message: "Email already verified" });
  }
  if (account.verificationTokenExpires && account.verificationTokenExpires < new Date()) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }
  await verify();
  return NextResponse.json({ success: true, message: "Email verified successfully" });
}

export async function POST(req: NextRequest) {
  let token: string | undefined;
  try {
    ({ token } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  // AdminUser (customer) verification — the original flow.
  const customer = await prisma.adminUser.findFirst({ where: { verificationToken: token } });
  if (customer) {
    return resolveVerification(
      customer,
      () =>
        prisma.adminUser.update({
          where: { id: customer.id },
          data: { verificationToken: null, verificationTokenExpires: null },
        }),
      () =>
        prisma.adminUser.update({
          where: { id: customer.id },
          data: {
            isVerified: true,
            verifiedAt: new Date(),
            verificationToken: null,
            verificationTokenExpires: null,
          },
        }),
    );
  }

  // Labeler User (email/password) verification — same flow, same page.
  const user = await prisma.user.findFirst({ where: { verificationToken: token } });
  if (user) {
    return resolveVerification(
      user,
      () =>
        prisma.user.update({
          where: { id: user.id },
          data: { verificationToken: null, verificationTokenExpires: null },
        }),
      () =>
        prisma.user.update({
          where: { id: user.id },
          data: {
            isVerified: true,
            verifiedAt: new Date(),
            verificationToken: null,
            verificationTokenExpires: null,
          },
        }),
    );
  }

  return NextResponse.json({ error: "invalid_token" }, { status: 400 });
}
