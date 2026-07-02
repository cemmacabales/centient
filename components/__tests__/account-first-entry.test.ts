// Smoke test for the P5a account-first default entry (#267). The repo has no
// React Testing Library / jsdom, so we render to static markup with
// react-dom/server (no extra deps, no JSX — vitest's include is *.test.ts) and
// assert the account path is primary and the wallet path is a labelled secondary.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => createElement("img", props),
}));

import LoginScreen from "@/components/LoginScreen";
import AccountAuthScreen from "@/components/AccountAuthScreen";

function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

describe("LoginScreen — account-first default (P5a)", () => {
  // ST-4c ripped EVM signature-login: email/password is now the only entry.
  const props = { onEmailAuth: () => {}, error: null };

  it("makes account creation the primary call to action", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).toContain("Create account");
    expect(html).toContain("no wallet needed");
  });

  it("offers a sign-in path for returning account users", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).toContain("Already have an account?");
    expect(html).toContain("Sign in");
  });

  it("no longer offers an EVM wallet-login path (ripped in ST-4c)", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).not.toContain("Have a wallet?");
    expect(html).not.toContain("Wallet login is still fully supported");
  });

  it("explains how the account relates to a wallet (one account holds the balance)", () => {
    const html = render(createElement(LoginScreen, props));
    expect(html).toContain("account");
    expect(html).toContain("withdraw");
  });

  it("surfaces the connect error when present", () => {
    const html = render(
      createElement(LoginScreen, { ...props, error: "Connection failed" }),
    );
    expect(html).toContain("Connection failed");
  });
});

describe("AccountAuthScreen — initial mode (P5a)", () => {
  const props = { onBack: () => {}, onLoggedIn: () => {} };

  it("opens in register mode when entering account-first", () => {
    const html = render(createElement(AccountAuthScreen, { ...props, initialMode: "register" }));
    expect(html).toContain("Create your account");
    expect(html).toContain("no wallet needed to start");
  });

  it("opens in login mode by default", () => {
    const html = render(createElement(AccountAuthScreen, props));
    expect(html).toContain("Welcome back");
  });
});
