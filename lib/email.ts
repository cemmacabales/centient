import * as Sentry from "@sentry/nextjs";
import { APP_URL } from "./constants";
import { sendEmail } from "./resend";
function escapeHtml(str: string): string {
    return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
function safeUrl(url: string): string {
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
            throw new Error("Unsafe URL scheme")
        }
        return escapeHtml(u.toString());
    } catch{
        return "#"
    }
}
export async function sendVerificationEmail(
    email: string,
    token: string,
    companyName?: string
) {
    if (APP_URL.includes("localhost") && process.env.NODE_ENV == "production"){
        throw new Error("[email] Fatal: APP_URL contains 'localhost' in production. Set NEXT_PUBLIC_APP_URL to your deployed URL.")
    } 
    const verificationUrl = `${APP_URL}/verify-email?token=${token}`;
    try {
        const result = await sendEmail(
            email,
            "Verify your email - Centient",
            `
                <h1>Verify your email</h1>
                <p>Hi ${escapeHtml (companyName || "there")},</p>
                <p>Confirm your email to start labeling and earning.</p>
                <a href="${safeUrl(verificationUrl)}">Verify Email →</a>
                <p>This link expires in 24 hours.</p>
            `,
        );
        return result;
  } catch (error) {
    console.error("[email] Failed to send verification email:", { email, error });
    Sentry.captureException(error, {
      extra: { email },
    });
    throw error;
  }
}
