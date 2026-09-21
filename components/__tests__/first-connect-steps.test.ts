// First-connect step states (#30). No React Testing Library / jsdom here, so each
// state renders to static markup with react-dom/server, as wallet-sign-in does;
// the flows themselves are covered in lib/stellar/__tests__/payout-setup.test.ts
// and wallet-claim.test.ts.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PayoutSetupView } from "@/components/PayoutSetup";
import { WalletClaimView } from "@/components/WalletClaim";
import {
  PAYOUT_SETUP_MESSAGES,
  PAYOUT_SIGNING_NOTICE,
  payoutWaitingNotice,
  type PayoutSetupFailure,
} from "@/lib/stellar/payout-setup";
import { WALLET_CLAIM_MESSAGES, type WalletClaimFailure } from "@/lib/stellar/wallet-claim";

const noop = () => {};

/** React escapes apostrophes in text; compare against the same escaping. */
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

describe("PayoutSetupView", () => {
  const render = (props: Parameters<typeof PayoutSetupView>[0]) =>
    renderToStaticMarkup(createElement(PayoutSetupView, props));

  it("says the wallet is where earnings are paid, and that no XLM is needed", () => {
    const html = render({ phase: "working", onRetry: noop });
    expect(html).toContain("Setting up USDC payouts");
    expect(html).toContain("where your earnings are paid");
    expect(html).toContain("you need no XLM");
  });

  it("marks the step busy while it checks the wallet, with no retry offered", () => {
    const html = render({ phase: "working", onRetry: noop });
    expect(html).toContain("Checking your wallet");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Try again");
  });

  it.each(["trustline", "account+trustline"] as const)(
    "shows the %s fee notice while Freighter is open",
    (kind) => {
      const html = render({ phase: "signing", signingKind: kind, onRetry: noop });
      expect(html).toContain(escaped(PAYOUT_SIGNING_NOTICE[kind]));
      expect(html).not.toContain("Try again");
    },
  );

  it("reads a rate limit as a wait that carries on by itself, with no retry offered", () => {
    const html = render({ phase: "waiting", waitSeconds: 12, onRetry: noop });
    expect(html).toContain(escaped(payoutWaitingNotice(12)));
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("text-error");
  });

  it("announces status changes to assistive technology", () => {
    const html = render({ phase: "failed", reason: "pending", onRetry: noop });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it.each(Object.keys(PAYOUT_SETUP_MESSAGES) as PayoutSetupFailure[])(
    "renders the %s failure with a retry and a way to sign out",
    (reason) => {
      const html = render({ phase: "failed", reason, onRetry: noop });
      expect(html).toContain(`data-failure="${reason}"`);
      expect(html).toContain(escaped(PAYOUT_SETUP_MESSAGES[reason]));
      expect(html).toContain("Try again");
      expect(html).toContain('action="/api/auth/logout"');
      expect(html).toContain('aria-busy="false"');
    },
  );

  it.each(Object.keys(PAYOUT_SETUP_MESSAGES) as PayoutSetupFailure[])(
    "never traps the contributor on the %s failure: they can continue into the app (PR #105 review)",
    (reason) => {
      const html = render({ phase: "failed", reason, onRetry: noop, onContinue: noop });
      expect(html).toContain("Continue for now");
      expect(html).toContain("Finish payout setup before you withdraw");
    },
  );

  it("offers to continue only once setup has failed", () => {
    expect(render({ phase: "working", onRetry: noop, onContinue: noop })).not.toContain("Continue for now");
    expect(render({ phase: "signing", signingKind: "trustline", onRetry: noop, onContinue: noop })).not.toContain(
      "Continue for now",
    );
  });

  it("styles a declined prompt as guidance, not an error", () => {
    expect(render({ phase: "failed", reason: "rejected", onRetry: noop })).not.toContain("text-error");
    expect(render({ phase: "failed", reason: "unavailable", onRetry: noop })).toContain("text-error");
  });
});

describe("WalletClaimView", () => {
  const render = (props: Parameters<typeof WalletClaimView>[0]) =>
    renderToStaticMarkup(createElement(WalletClaimView, props));

  it("asks an email account to connect a wallet, keeping its balance", () => {
    const html = render({ phase: "idle", onConnect: noop });
    expect(html).toContain("Connect your wallet to keep earning");
    expect(html).toContain("your balance");
    expect(html).toContain("stays with this account");
    expect(html).toContain("Connect Freighter");
    expect(html).not.toContain('type="password"');
  });

  it("disables the button and marks it busy while Freighter is open", () => {
    const html = render({ phase: "connecting", onConnect: noop });
    expect(html).toContain("Waiting for Freighter");
    expect(html).toMatch(/disabled=""/);
    expect(html).toContain('aria-busy="true"');
  });

  it("always offers a way to sign out", () => {
    expect(render({ phase: "idle", onConnect: noop })).toContain('action="/api/auth/logout"');
  });

  it.each(Object.keys(WALLET_CLAIM_MESSAGES) as WalletClaimFailure[])("renders the %s failure", (reason) => {
    const html = render({ phase: "failed", reason, onConnect: noop });
    expect(html).toContain(`data-failure="${reason}"`);
    expect(html).toContain(escaped(WALLET_CLAIM_MESSAGES[reason]));
    expect(html).toContain("Try again");
  });

  it("links to the Freighter install page only when Freighter is missing", () => {
    expect(render({ phase: "failed", reason: "freighter_missing", onConnect: noop })).toContain(
      "https://www.freighter.app/",
    );
    expect(render({ phase: "failed", reason: "expired", onConnect: noop })).not.toContain(
      "https://www.freighter.app/",
    );
  });
});
