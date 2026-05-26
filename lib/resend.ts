import { Resend } from "resend";
const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_EMAIL_FROM ?? "Centient <onboarding@resend.dev>";
export const resendClient = apiKey ? new Resend(apiKey) : null;
export async function sendEmail(to: string, subject: string, html: string){
    if (!resendClient){
        console.log("[resend] RESEND_API_KEY not set, skipping email");
        return null;
    }
    return resendClient.emails.send({ from: fromEmail, to, subject, html});
}
