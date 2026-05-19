import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest) {
    const { token } = await req.json();
    
    console.log("[verify-email] Received token:", token);
    
    if (!token) {
        return NextResponse.json({ error: "missing_token" }, { status: 400 });
    }

    // Debug: Find any customer with this token (regardless of expiry/verified status)
    const anyCustomerWithToken = await prisma.adminUser.findFirst({
        where: { verificationToken: token },
    });
    console.log("[verify-email] Found customer with token:", anyCustomerWithToken?.email, {
        isVerified: anyCustomerWithToken?.isVerified,
        tokenExpires: anyCustomerWithToken?.verificationTokenExpires,
        now: new Date(),
    });

    const customer = await prisma.adminUser.findFirst({
        where: {
            verificationToken: token,
            verificationTokenExpires: { gt: new Date() },
            isVerified: false,
        },
    });

    if (!customer) {
        // Check if already verified
        const alreadyVerified = await prisma.adminUser.findFirst({
            where: { verificationToken: token, isVerified: true },
        });
        if (alreadyVerified) {
            return NextResponse.json({ success: true, message: "Email already verified" });
        }
        return NextResponse.json({ error: "invalid_token" }, { status: 400 });
    }

    await prisma.adminUser.update({
        where: { id: customer.id },
        data: {
            isVerified: true,
            verifiedAt: new Date(),
            verificationToken: null,
            verificationTokenExpires: null,
        },
    });

    console.log("[verify-email] Successfully verified:", customer.email);
    return NextResponse.json({ success: true, message: "Email verified successfully" });
}