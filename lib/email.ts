import { Resend } from "resend";
import { APP_URL } from "./constants";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
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
    if (!resend) {
        console.log("[email] RESEND_API_KEY not set, skipping verification email");
        return null;
    }
    if (APP_URL.includes("localhost") && process.env.NODE_ENV == "production"){
        console.error ("[email] FATAL: NEXT_PUBLIC_APP_URL is not set. Verification links will not point to localhost.");
        return null;
    } 
    const verificationUrl = `${APP_URL}/verify-email?token=${token}`;
    try {
        const result = await resend.emails.send({
            from: process.env.RESEND_EMAIL_FROM ?? "Centient <onboarding@resend.dev>",
            to: email,
            subject: "Verify your email - Centient",
            html: `
                <h1>Verify your email</h1>
                <p>Hi ${escapeHtml (companyName || "there")},</p>
                <p>Confirm your email to start labeling and earning.</p>
                <a href="${safeUrl(verificationUrl)}">Verify Email →</a>
                <p>This link expires in 24 hours.</p>
            `,
        });
        return result;
    } catch (error) {
        console.error("[email] Failed to send verification email:", { email, error });
        throw error;
    }
}