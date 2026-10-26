// Where Lantern is (lantern.ts): off unless configured, Android only, framed by
// a listed origin when inside it, and an intent link that names the package.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LANTERN_PACKAGE,
  isInLantern,
  isLanternEnabled,
  isLanternInstalled,
  lanternOpenUrl,
  parseLanternOrigins,
  walletCopy,
} from "@/lib/stellar/lantern";

const LANTERN = "https://android.golantern.xyz";
const EXTENSION = "chrome-extension://iflpkjgolcbleombhldiibhojohjpnmd";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

/** A top-level page (not framed). */
function topLevel() {
  const win = {} as Record<string, unknown>;
  win.self = win;
  win.top = win;
  win.location = { href: "https://centient.work/" };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { referrer: "" });
}

/** A page framed by `origin`. */
function framedBy(origin: string) {
  vi.stubGlobal("window", { self: {}, top: {}, location: { ancestorOrigins: [origin] } });
  vi.stubGlobal("document", { referrer: "" });
}

function phone(userAgent: string, installed: { id?: string; platform?: string }[] | Error | null) {
  vi.stubGlobal("navigator", {
    userAgent,
    ...(installed !== null && {
      getInstalledRelatedApps: vi.fn(() =>
        installed instanceof Error ? Promise.reject(installed) : Promise.resolve(installed),
      ),
    }),
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_LANTERN_ORIGINS = LANTERN;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_LANTERN_ORIGINS;
  vi.unstubAllGlobals();
});

describe("parseLanternOrigins", () => {
  it("splits on commas and spaces and drops trailing slashes", () => {
    expect(parseLanternOrigins("https://android.golantern.xyz/, http://localhost:5199  capacitor://x")).toEqual([
      "https://android.golantern.xyz",
      "http://localhost:5199",
    ]);
  });

  it("refuses anything with a path, so the CSP only ever gets origins", () => {
    expect(parseLanternOrigins("https://evil.example/path 'unsafe-inline' *")).toEqual([]);
  });

  it("is empty when unset", () => {
    expect(parseLanternOrigins(undefined)).toEqual([]);
  });

  it("keeps the Chrome extension's pinned origin", () => {
    expect(parseLanternOrigins(`${LANTERN} ${EXTENSION}/`)).toEqual([LANTERN, EXTENSION]);
  });

  it("refuses the bare extension scheme, a malformed id, or a path, so no other extension can frame us", () => {
    expect(
      parseLanternOrigins(
        [
          "chrome-extension:",
          "chrome-extension://",
          "chrome-extension://*",
          "chrome-extension://iflpkjgolcbleombhldiibhojohjpn",
          "chrome-extension://IFLPKJGOLCBLEOMBHLDIIBHOJOHJPNMD",
          "chrome-extension://zflpkjgolcbleombhldiibhojohjpnmd",
          `${EXTENSION}/popup.html`,
        ].join(" "),
      ),
    ).toEqual([]);
  });
});

describe("isLanternEnabled", () => {
  it("is off until origins are configured", () => {
    delete process.env.NEXT_PUBLIC_LANTERN_ORIGINS;
    expect(isLanternEnabled()).toBe(false);
  });
});

describe("isInLantern", () => {
  it("is true when framed by a Lantern origin", () => {
    framedBy(LANTERN);
    expect(isInLantern()).toBe(true);
  });

  it("is false when framed by anything else", () => {
    framedBy("https://evil.example");
    expect(isInLantern()).toBe(false);
  });

  it("is true when framed by Lantern's Chrome extension, on any platform", () => {
    process.env.NEXT_PUBLIC_LANTERN_ORIGINS = `${LANTERN} ${EXTENSION}`;
    framedBy(EXTENSION);
    expect(isInLantern()).toBe(true);
  });

  it("is false when framed by any other extension", () => {
    process.env.NEXT_PUBLIC_LANTERN_ORIGINS = `${LANTERN} ${EXTENSION}`;
    framedBy("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(isInLantern()).toBe(false);
  });

  it("is false when framed by https://localhost, which every Capacitor app shares", () => {
    framedBy("https://localhost");
    expect(isInLantern()).toBe(false);
  });

  it("is false at the top level", () => {
    topLevel();
    expect(isInLantern()).toBe(false);
  });

  it("falls back to the referrer when the browser has no ancestorOrigins", () => {
    vi.stubGlobal("window", { self: {}, top: {}, location: {} });
    vi.stubGlobal("document", { referrer: "https://android.golantern.xyz/apps" });
    expect(isInLantern()).toBe(true);
  });
});

describe("isLanternInstalled", () => {
  it("is true on Android when Chrome reports the package", async () => {
    topLevel();
    phone(ANDROID_UA, [{ platform: "play", id: LANTERN_PACKAGE }]);
    expect(await isLanternInstalled()).toBe(true);
  });

  it("is false on Android when Lantern isn't among the related apps", async () => {
    topLevel();
    phone(ANDROID_UA, [{ platform: "play", id: "com.other.app" }]);
    expect(await isLanternInstalled()).toBe(false);
  });

  it("is false on an iPhone, without asking", async () => {
    topLevel();
    phone(IPHONE_UA, [{ platform: "play", id: LANTERN_PACKAGE }]);
    expect(await isLanternInstalled()).toBe(false);
  });

  it("is false when the browser has no getInstalledRelatedApps", async () => {
    topLevel();
    phone(ANDROID_UA, null);
    expect(await isLanternInstalled()).toBe(false);
  });

  it("is false, not thrown, when the lookup fails", async () => {
    topLevel();
    phone(ANDROID_UA, new Error("SecurityError"));
    expect(await isLanternInstalled()).toBe(false);
  });

  it("is false when the deployment hasn't enabled Lantern", async () => {
    delete process.env.NEXT_PUBLIC_LANTERN_ORIGINS;
    topLevel();
    phone(ANDROID_UA, [{ platform: "play", id: LANTERN_PACKAGE }]);
    expect(await isLanternInstalled()).toBe(false);
  });

  it("is false once already inside Lantern: there is nothing to open", async () => {
    framedBy(LANTERN);
    phone(ANDROID_UA, [{ platform: "play", id: LANTERN_PACKAGE }]);
    expect(await isLanternInstalled()).toBe(false);
  });
});

describe("lanternOpenUrl", () => {
  it("is an intent for lantern://open carrying the page, with the page as the fallback", () => {
    const url = lanternOpenUrl("https://centient.work/?ref=x&y=1");
    const encoded = encodeURIComponent("https://centient.work/?ref=x&y=1");
    expect(url).toBe(
      `intent://open?url=${encoded}#Intent;scheme=lantern;package=com.lantern.wallet;S.browser_fallback_url=${encoded};end`,
    );
  });
});

describe("walletCopy", () => {
  it("names Lantern inside Lantern", () => {
    expect(walletCopy("You declined the request in Freighter. Open the Freighter app.", "lantern")).toBe(
      "You declined the request in Lantern. Open Lantern.",
    );
  });

  it("leaves Freighter copy alone everywhere else", () => {
    expect(walletCopy("Approve in Freighter.", "walletconnect")).toBe("Approve in Freighter.");
    expect(walletCopy("Approve in Freighter.", null)).toBe("Approve in Freighter.");
  });
});
