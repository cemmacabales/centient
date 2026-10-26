// Where Lantern is, as far as this page can tell. Lantern is an Android-only
// Stellar wallet (`com.lantern.wallet`) that runs dApps *inside itself*: its
// Apps tab loads a site in a frame and signs for it over `postMessage` (the
// bridge lives in wallet-lantern.ts). So the page can be in one of three places:
//
//   • **inside Lantern** — framed by a Lantern origin. Sign in through the bridge.
//   • **on an Android phone that has Lantern** — offer to reopen Centient inside
//     Lantern instead of pairing Freighter.
//   • anywhere else — Lantern doesn't exist here; the Freighter path is untouched.
//
// The whole feature is off until `NEXT_PUBLIC_LANTERN_ORIGINS` lists the
// origins Lantern frames dApps from. Since Lantern 0.6.0 its Android webview is
// `https://android.golantern.xyz`. Up to 0.5.x it was `https://localhost`,
// Capacitor's default, which every Capacitor app on the phone shares, so don't
// list that one: any of those apps could frame Centient and pass the bridge's
// origin check. The same list is what next.config.ts lets frame this app, so an
// unconfigured deployment can neither be framed by Lantern nor offer it.
//
// Lantern's Chrome extension frames dApps too, from `chrome-extension://<id>`.
// Lantern pins that id with a manifest `key`, so one exact
// `chrome-extension://` origin can be listed. Only a full 32-letter id is
// accepted: the bare scheme would let any installed extension frame Centient.
//
// Detection and opening depend on Lantern listing this site in its curated
// directory: 0.6.0 follows `lantern://open` only for directory sites, and
// generates the `asset_statements` that Chrome's `getInstalledRelatedApps()`
// reads from the same list. Until Centient is listed, the link is refused and
// the page stays in the browser. See docs/lantern-integration.md.

/** Lantern's Android application id. */
export const LANTERN_PACKAGE = "com.lantern.wallet";

/** The origins Lantern frames dApps from, from `NEXT_PUBLIC_LANTERN_ORIGINS`. */
export function lanternOrigins(): string[] {
  return parseLanternOrigins(process.env.NEXT_PUBLIC_LANTERN_ORIGINS);
}

/** Split a comma- or space-separated origin list, dropping anything that isn't an origin. */
export function parseLanternOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^/\s]+$/i.test(s) || /^chrome-extension:\/\/[a-p]{32}$/.test(s));
}

/** True when this deployment offers Lantern at all. */
export function isLanternEnabled(): boolean {
  return lanternOrigins().length > 0;
}

/** Android, and not an iPad pretending to be a desktop: Lantern ships nowhere else. */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android/i.test(navigator.userAgent);
}

/**
 * The origin of the page framing this one, or null when it isn't framed or the
 * browser won't say. `ancestorOrigins` is Chromium's (and so Android WebView's);
 * the referrer is the fallback, and is the framing page for a first load.
 */
export function parentOrigin(): string | null {
  if (typeof window === "undefined" || window.self === window.top) return null;
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0];
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

/**
 * True when this page is running inside Lantern's Apps tab. Being framed by a
 * listed origin is enough: the CSP's `frame-ancestors` admits only those, so
 * nothing else can be framing us.
 */
export function isInLantern(): boolean {
  const parent = parentOrigin();
  return parent !== null && lanternOrigins().includes(parent);
}

interface RelatedApp {
  id?: string;
  platform?: string;
}

/**
 * True when Chrome on Android reports Lantern installed. Needs Lantern's
 * `asset_statements` to name this site, and `related_applications` in
 * site.webmanifest to name Lantern; either missing and the answer is simply no,
 * which leaves the Freighter button in place. Never throws.
 */
export async function isLanternInstalled(): Promise<boolean> {
  if (!isLanternEnabled() || !isAndroid() || isInLantern()) return false;
  const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> };
  if (typeof nav.getInstalledRelatedApps !== "function") return false;
  try {
    const apps = await nav.getInstalledRelatedApps();
    return apps.some((app) => app.id === LANTERN_PACKAGE);
  } catch {
    return false;
  }
}

/**
 * An Android intent link that opens `target` inside Lantern's Apps tab. Chrome
 * hands it to Lantern's `lantern://open` filter; if Lantern can't take it, the
 * fallback brings the contributor back to `target` in this browser rather than
 * to a Play Store page for a sideloaded app.
 */
export function lanternOpenUrl(target: string): string {
  const encoded = encodeURIComponent(target);
  return `intent://open?url=${encoded}#Intent;scheme=lantern;package=${LANTERN_PACKAGE};S.browser_fallback_url=${encoded};end`;
}

/**
 * Freighter copy, reworded for Lantern when that is the wallet in use. The
 * sign-in, claim and payout messages name Freighter throughout; inside Lantern
 * every one of them means Lantern, so they are rewritten rather than forked.
 */
export function walletCopy(text: string, transport: string | null | undefined): string {
  return transport === "lantern" ? text.replace(/the Freighter app|Freighter/g, "Lantern") : text;
}
