// #203: an invite link opens https://centient.work/?invite=ABCD2345. The code
// goes into a short-lived cookie, which the wallet sign-in route reads when it
// creates the account, and the param is stripped so a reload or a shared
// screenshot doesn't carry it. There is nothing to redeem: an existing account
// ignores the cookie.
import { INVITE_RULES, normalizeInviteCode } from "./invite-rules";

/** Move an `?invite=` from the address bar into the invite cookie. Browser only. */
export function captureInviteFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("invite");
    if (raw === null) return;
    const code = normalizeInviteCode(raw);
    if (code) {
      const secure = url.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${INVITE_RULES.cookie}=${code}; Max-Age=${INVITE_RULES.cookieDays * 86_400}; Path=/; SameSite=Lax${secure}`;
    }
    url.searchParams.delete("invite");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Cookies blocked or no history API: the friend can still sign up, uninvited.
  }
}
