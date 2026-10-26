// #203: a booth QR opens https://centient.work/?code=BQF2026. The code is kept
// in this tab's sessionStorage, so it survives the wallet sign-in, and the
// param is stripped so a reload or a shared screenshot doesn't carry it. The
// labeler still taps Add: a link never redeems on its own.
import { normalizeCode } from "./events";

const KEY = "centient.eventCode";

/** Move a `?code=` from the address bar into this tab's storage. Browser only. */
export function captureCodeFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("code");
    if (raw === null) return;
    const code = normalizeCode(raw);
    if (code) sessionStorage.setItem(KEY, code);
    url.searchParams.delete("code");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Storage blocked or no history API: the labeler can still type the code.
  }
}

export function pendingCode(): string | null {
  try {
    return normalizeCode(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function clearPendingCode(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
