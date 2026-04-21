import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export interface AdminSession {
  adminId?: string;
  username?: string;
  save: () => Promise<void>;
  destroy: () => Promise<void>;
}

interface AdminSessionData {
  adminId?: string;
  username?: string;
}

function sessionOptions() {
  const password = process.env.ADMIN_SESSION_PASSWORD ?? "";
  if (password.length < 32) {
    throw new Error(
      "ADMIN_SESSION_PASSWORD must be set to a secret at least 32 characters long",
    );
  }
  return {
    password,
    cookieName: "centient_admin",
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge: 60 * 60 * 8,
      path: "/",
    },
  };
}

export async function getAdminSession() {
  const jar = await cookies();
  return getIronSession<AdminSessionData>(jar, sessionOptions());
}

export async function requireAdmin() {
  const session = await getAdminSession();
  if (!session.adminId) redirect("/admin/login");
  return session;
}
