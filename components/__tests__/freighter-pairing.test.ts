// @vitest-environment jsdom
// The pairing prompt — the screen that stands between "Connect Freighter" on a
// phone and the Freighter app actually opening.
//
// What matters here isn't markup, it's the hand-off: on the device that holds
// the wallet the pairing has to reach the app by itself, exactly once, and when
// it doesn't there has to be a control the contributor can still reach. A deep
// link either switches apps or does nothing observable, so there is no failure
// event to test against — only that the recovery path is present and works.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import FreighterPairing, { FreighterPairingView } from "@/components/FreighterPairing";
import {
  connect,
  emitPairingForTest,
  pairingIsPending,
  setWalletConnectProvider,
  type WalletConnectPairing,
  type WalletConnectProvider,
} from "@/lib/stellar/wallet-connect";

const URI = "wc:abc123@2?relay-protocol=irn&symKey=deadbeef";
const DEEP_LINK = `freighterwallet://wc?uri=${encodeURIComponent(URI)}`;

const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

/** Point `navigator.userAgent` at a phone or a desktop for one test. */
function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

/** `window.location.href` is read-only in jsdom; swap in a recorder. */
function captureNavigation(): { href: string | null } {
  const record: { href: string | null } = { href: null };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      get href() {
        return "http://localhost/";
      },
      set href(value: string) {
        record.href = value;
      },
    },
  });
  return record;
}

function pairing(overrides: Partial<WalletConnectPairing> = {}): WalletConnectPairing {
  return { uri: URI, deepLink: DEEP_LINK, linkIsExact: true, ...overrides };
}

const noop = () => {};

beforeEach(() => {
  setUserAgent(DESKTOP_UA);
});

afterEach(() => {
  cleanup();
  setWalletConnectProvider(null);
  vi.restoreAllMocks();
});

/**
 * Start a real `connect()` against a wallet that never answers, and show its
 * pairing — the state #138 is about: the contributor walked away from Freighter.
 */
async function abandonedPairing(): Promise<{ attempt: Promise<unknown> }> {
  const provider: WalletConnectProvider = {
    connect: () => new Promise<never>(() => {}),
    request: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as WalletConnectProvider;
  setWalletConnectProvider(provider);
  const attempt = connect();
  attempt.catch(() => {});
  await vi.waitFor(() => expect(pairingIsPending()).toBe(true));
  await act(async () => {
    emitPairingForTest(pairing());
  });
  // Wrapped: returning the bare promise would make this helper wait on it.
  return { attempt };
}

describe("FreighterPairingView", () => {
  it("offers the app on the device that holds the wallet", () => {
    render(
      createElement(FreighterPairingView, {
        pairing: pairing(),
        onWalletDevice: true,
        qrSvg: null,
        copied: false,
        onCopy: noop,
        onOpenApp: noop,
        onCancel: noop,
      }),
    );

    expect(screen.getByRole("button", { name: /open freighter/i })).toBeTruthy();
    // A QR is useless on the device doing the scanning.
    expect(document.querySelector("[data-qr]")).toBeNull();
  });

  it("keeps a way through when the link is only a best guess", () => {
    render(
      createElement(FreighterPairingView, {
        pairing: pairing({ linkIsExact: false }),
        onWalletDevice: true,
        qrSvg: null,
        copied: false,
        onCopy: noop,
        onOpenApp: noop,
        onCancel: noop,
      }),
    );

    const button = screen.getByRole("button", { name: /open freighter/i });
    expect(button.getAttribute("data-link")).toBe("fallback");
    expect(button.hasAttribute("disabled")).toBe(false);
    // The recovery path is what makes a wrong guess survivable.
    expect(screen.getByRole("button", { name: /copy pairing link/i })).toBeTruthy();
    expect(document.body.textContent).toMatch(/nothing happened/i);
  });

  it("disables the button only while the link is still resolving", () => {
    render(
      createElement(FreighterPairingView, {
        pairing: pairing({ deepLink: null, linkIsExact: false }),
        onWalletDevice: true,
        qrSvg: null,
        copied: false,
        onCopy: noop,
        onOpenApp: noop,
        onCancel: noop,
      }),
    );

    const button = screen.getByRole("button", { name: /open freighter/i });
    expect(button.getAttribute("data-link")).toBe("pending");
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("shows a QR on a second device instead of a link into nothing", () => {
    render(
      createElement(FreighterPairingView, {
        pairing: pairing(),
        onWalletDevice: false,
        qrSvg: "<svg role='img'></svg>",
        copied: false,
        onCopy: noop,
        onOpenApp: noop,
        onCancel: noop,
      }),
    );

    expect(document.querySelector('[data-qr="ready"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open freighter/i })).toBeNull();
  });
});

describe("FreighterPairing", () => {
  it("renders nothing until a pairing needs the contributor", () => {
    const { container } = render(createElement(FreighterPairing));
    expect(container.innerHTML).toBe("");
  });

  it("hands the pairing to the Freighter app by itself, on a phone", async () => {
    setUserAgent(PHONE_UA);
    const nav = captureNavigation();
    render(createElement(FreighterPairing));
    await act(async () => {
      emitPairingForTest(pairing());
    });

    expect(nav.href).toBe(DEEP_LINK);
  });

  it("does not navigate away on a desktop, where the wallet is elsewhere", async () => {
    setUserAgent(DESKTOP_UA);
    const nav = captureNavigation();

    render(createElement(FreighterPairing));
    await act(async () => {
      emitPairingForTest(pairing());
    });

    expect(nav.href).toBeNull();
  });

  it("hands off once per pairing, not once per render", async () => {
    setUserAgent(PHONE_UA);
    const nav = captureNavigation();

    const { rerender } = render(createElement(FreighterPairing));
    await act(async () => {
      emitPairingForTest(pairing());
    });
    expect(nav.href).toBe(DEEP_LINK);

    nav.href = null;
    await act(async () => {
      rerender(createElement(FreighterPairing));
    });
    // Re-rendering must not yank the contributor out of the browser again.
    expect(nav.href).toBeNull();
  });

  it("copies the pairing uri, not the deep link, for pasting into Freighter", async () => {
    setUserAgent(PHONE_UA);
    captureNavigation();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(createElement(FreighterPairing));
    await act(async () => {
      emitPairingForTest(pairing());
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy pairing link/i }));
    });

    expect(writeText).toHaveBeenCalledWith(URI);
  });

  it("cancels an abandoned pairing and closes, on a phone", async () => {
    setUserAgent(PHONE_UA);
    captureNavigation();
    render(createElement(FreighterPairing));
    const { attempt } = await abandonedPairing();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    });

    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels on Escape, on a desktop", async () => {
    setUserAgent(DESKTOP_UA);
    render(createElement(FreighterPairing));
    const { attempt } = await abandonedPairing();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    await expect(attempt).rejects.toMatchObject({ code: "cancelled" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
