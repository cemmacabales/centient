import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest) {
    let token: string | undefined;
    try{
        ({ token } = await req.json());
    } catch {
        return NextResponse.json({ error: "invalid_body"}, {status: 400});
    }
    if (!token) {
        return NextResponse.json({ error: "missing_token" }, { status: 400 });
    }

    const customer = await prisma.adminUser.findFirst({
        where: {
            verificationToken: token,
        },
    });

    if (!customer) {
        return NextResponse.json({ error: "invalid_token" }, { status: 400 });
    }
    if (customer.isVerified){
        await prisma.adminUser.update({
            where: { id: customer.id},
            data: {verificationToken: null, verificationTokenExpires: null},
        });
        return NextResponse.json({ success: true, message: "Email already verified"});
    }
    if (customer.verificationTokenExpires && customer.verificationTokenExpires < new Date()){
        return NextResponse.json({ error: "invalid_token"}, {status: 400});
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

    return NextResponse.json({ success: true, message: "Email verified successfully" });
}
