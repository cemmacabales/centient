import { Resend } from "resend";

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
    const verificationUrl = `${process.env.NEXT_PUBLIC_APP_URL}/verify-email?token=${token}`;
    try {
        const result = await resend.emails.send({
            from: "Centient <onboarding@resend.dev>",
            to: email,
            subject: "Verify your Centient Account",
            html: `
                <h1>Welcome to Centient!</h1>
                <p>Hi ${escapeHtml (companyName || "there")},</p>
                <p>Please verify your email address by clicking the link below:</p>
                <a href="${safeUrl(verificationUrl)}">Verify Email</a>
                <p>This link expires in 24 hours.</p>
            `,
        });
        console.log("[email] Verification email sent:", { email, result });
        return result;
    } catch (error) {
        console.error("[email] Failed to send verification email:", { email, error });
        throw error;
    }
}