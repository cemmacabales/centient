// Freighter sign-in states (#26). No React Testing Library / jsdom here, so each
// state renders to static markup with react-dom/server, as account-first-entry
// does; the state transitions themselves are covered in
// lib/stellar/__tests__/wallet-sign-in.test.ts.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletSignInView } from "@/components/WalletSignIn";
import { WALLET_SIGN_IN_MESSAGES, type WalletSignInFailure } from "@/lib/stellar/wallet-sign-in";

const noop = () => {};

/** Render one WalletSignInView state to static HTML. */
function render(props: Parameters<typeof WalletSignInView>[0]): string {
  return renderToStaticMarkup(createElement(WalletSignInView, props));
}

describe("WalletSignInView", () => {
  it("offers Freighter as the connect action when idle", () => {
    const html = render({ phase: "idle", onConnect: noop });
    expect(html).toContain("Connect Freighter");
    // The class list carries `disabled:opacity-60`, so match the attribute itself.
    expect(html).not.toMatch(/disabled=""/);
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain("data-failure");
  });

  it("disables the button and marks it busy while Freighter is open", () => {
    const html = render({ phase: "connecting", onConnect: noop });
    expect(html).toContain("Waiting for Freighter");
    expect(html).toMatch(/disabled=""/);
    expect(html).toContain('aria-busy="true"');
  });

  it("announces status changes to assistive technology", () => {
    const html = render({ phase: "failed", reason: "expired", onConnect: noop });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  const failures: WalletSignInFailure[] = [
    "freighter_missing",
    "rejected",
    "wrong_account",
    "unsupported",
    "expired",
    "rate_limited",
    "network",
    "failed",
  ];

  it.each(failures)("shows the %s message with a retry action", (reason) => {
    const html = render({ phase: "failed", reason, onConnect: noop });
    // renderToStaticMarkup escapes apostrophes.
    expect(html).toContain(WALLET_SIGN_IN_MESSAGES[reason].replace(/'/g, "&#x27;"));
    expect(html).toContain("Try again");
    expect(html).toContain(`data-failure="${reason}"`);
  });

  it("links to the Freighter install page only when Freighter is missing", () => {
    const missing = render({ phase: "failed", reason: "freighter_missing", onConnect: noop });
    expect(missing).toContain('href="https://www.freighter.app/"');
    expect(missing).toContain('rel="noopener noreferrer"');

    const other = render({ phase: "failed", reason: "expired", onConnect: noop });
    expect(other).not.toContain("freighter.app");
  });

  it("offers Cancel while waiting on the Freighter app, where a request can go unanswered", () => {
    const html = render({ phase: "connecting", transport: "walletconnect", onConnect: noop, onCancel: noop });
    expect(html).toMatch(/>Cancel</);
  });

  it("offers no Cancel on the extension path, whose prompt closes itself", () => {
    const html = render({ phase: "connecting", transport: "extension", onConnect: noop, onCancel: noop });
    expect(html).not.toMatch(/>Cancel</);
  });

  it("offers no Cancel when nothing is being waited on", () => {
    const html = render({ phase: "idle", transport: "walletconnect", onConnect: noop, onCancel: noop });
    expect(html).not.toMatch(/>Cancel</);
  });

  it("styles a cancelled request as guidance, not an error", () => {
    const html = render({ phase: "failed", reason: "cancelled", onConnect: noop });
    expect(html).toContain('data-failure="cancelled"');
    expect(html).not.toContain("text-error");
  });

  it("styles a declined prompt as guidance, not an error", () => {
    expect(render({ phase: "failed", reason: "rejected", onConnect: noop })).not.toContain("text-error");
    expect(render({ phase: "failed", reason: "wrong_account", onConnect: noop })).toContain("text-error");
  });
});

describe("WalletSignInView — Lantern", () => {
  const HREF = "intent://open?url=x#Intent;scheme=lantern;package=com.lantern.wallet;end";

  it("leads with Open in Lantern on a phone that has it, with Freighter one tap behind", () => {
    const html = render({ phase: "idle", onConnect: noop, lanternHref: HREF, onUseFreighter: noop });
    expect(html).toContain("Open in Lantern");
    expect(html).toContain('data-lantern="open"');
    expect(html).toContain(`href="${HREF.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("Use Freighter instead");
    expect(html).not.toContain("Connect Freighter");
  });

  it("keeps the Freighter button when there is no Lantern to open", () => {
    const html = render({ phase: "idle", onConnect: noop, lanternHref: null });
    expect(html).toContain("Connect Freighter");
    expect(html).not.toContain("Lantern");
  });

  it("shows a Freighter attempt's own state rather than the Lantern offer", () => {
    const html = render({ phase: "failed", reason: "rejected", onConnect: noop, lanternHref: HREF });
    expect(html).toContain("Try again");
    expect(html).not.toContain("Open in Lantern");
  });

  it("connects through Lantern, in Lantern's button, when running inside it", () => {
    const html = render({ phase: "idle", transport: "lantern", onConnect: noop, lanternHref: HREF });
    expect(html).toContain("Connect Lantern");
    expect(html).toContain('data-lantern="connect"');
    expect(html).not.toContain("Open in Lantern");
  });

  it("waits on Lantern, cancellably, and names Lantern in a failure", () => {
    expect(render({ phase: "connecting", transport: "lantern", onConnect: noop, onCancel: noop })).toContain(
      "Waiting for Lantern",
    );
    const failed = render({ phase: "failed", reason: "rejected", transport: "lantern", onConnect: noop });
    expect(failed).not.toContain("Freighter");
  });
});
