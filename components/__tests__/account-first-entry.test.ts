// Smoke test for the contributor entry screen. The repo has no React Testing
// Library / jsdom, so we render to static markup with react-dom/server (no extra
// deps, no JSX — vitest's include is *.test.ts).
//
// #26 made the entry wallet-first: Freighter sign-in is primary. #30 retired
// email sign-up: email sign-in remains only for accounts that already exist, so
// they can claim a wallet.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => createElement("img", props),
}));

import LoginScreen from "@/components/LoginScreen";
import AccountAuthScreen from "@/components/AccountAuthScreen";

/** Render a React element to static HTML for string assertions. */
function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

describe("LoginScreen — wallet-first entry (#26)", () => {
  const props = { onWalletSignedIn: () => {}, onEmailSignIn: () => {}, error: null };

  it("makes Freighter sign-in the primary call to action", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).toContain("Connect Freighter");
    expect(html.indexOf("Connect Freighter")).toBeLessThan(html.indexOf("Sign in with email"));
  });

  it("does not require email or password to start", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).toContain("no email or password needed");
    expect(html).not.toContain("Create account");
    expect(html).not.toContain('type="password"');
  });

  it("keeps email sign-in only so an existing email account can connect its wallet (#30)", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).toContain("Signed up with email before?");
    expect(html).toContain("Sign in with email");
    expect(html).toContain("to connect your wallet");
  });

  it("offers no MiniPay or EVM wallet-login path", () => {
    const html = render(createElement(LoginScreen, props)).toLowerCase();
    expect(html).not.toContain("minipay");
    expect(html).not.toContain("metamask");
    expect(html).not.toContain("have a wallet?");
  });

  it("explains that the wallet address is the account and payout destination, and signing moves no funds", () => {
    const html = render(createElement(LoginScreen, props));
    // The explicit {" "} keeps the space after the bold span.
    expect(html).toContain("wallet address</span> is your account and where your USDC is paid");
    expect(html).toContain("never moves funds");
  });

  it("surfaces the connect error when present", () => {
    const html = render(createElement(LoginScreen, { ...props, error: "Connection failed" }));
    expect(html).toContain("Connection failed");
  });

  it("links the public docs from the header, on every screen size, in a new tab", () => {
    const html = render(createElement(LoginScreen, props));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const link = header.match(/<a[^>]*href="https:\/\/centient\.gitbook\.io\/centient-docs\/"[^>]*>.*?<\/a>/)?.[0];
    expect(link).toBeDefined();
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain("Docs");
    // The section links hide below `sm`; the docs link must not sit inside them.
    expect(header.indexOf(link!)).toBeGreaterThan(header.indexOf("</nav>"));
  });
});

describe("AccountAuthScreen — email sign-in for existing accounts (#30)", () => {
  const props = { onBack: () => {}, onLoggedIn: () => {} };

  it("signs in an existing email account and says a wallet comes next", () => {
    const html = render(createElement(AccountAuthScreen, props));
    expect(html).toContain("Welcome back");
    expect(html).toContain("connect your Stellar wallet");
    expect(html).toContain('type="password"');
  });

  it("offers no way to create an account", () => {
    const html = render(createElement(AccountAuthScreen, props));
    expect(html).not.toContain("Create your account");
    expect(html).not.toContain("Create an account");
    expect(html).not.toContain("no wallet needed");
  });
});
