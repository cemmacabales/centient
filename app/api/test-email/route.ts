import { NextRequest, NextResponse } from "next/server";
import { sendVerificationEmail } from "@/lib/email";

export async function POST(req: NextRequest) {
  const { email, companyName } = await req.json();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const testToken = "test_token_" + Date.now();

  try {
    await sendVerificationEmail(email, testToken, companyName || "Test Company");
    return NextResponse.json({ success: true, message: "Email sent!" });
  } catch (error: any) {
    console.error("[test-email] Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to send email" },
      { status: 500 }
    );
  }
}