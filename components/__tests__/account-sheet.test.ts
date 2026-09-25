// The account sheet after #39. Answers are paid on-chain as they are accepted,
// so the sheet shows what was earned and each answer's payout status; the old
// "pending balance" and its withdraw controls appear only while a legacy balance
// from before instant payout is still owed. Static markup, as the other
// component tests here: no React Testing Library / jsdom.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountSheet, { LegacyBalanceCard } from "@/components/AccountSheet";

const G_WALLET = "GCKIPQX2TEZWBQSUPPNMKGJBODL246B374Y52SPD2OGJ2AAQ6SHYUR6E";
const noop = () => {};

type CardProps = Parameters<typeof LegacyBalanceCard>[0];

function card(overrides: Partial<CardProps["data"]> = {}, props: Partial<CardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(LegacyBalanceCard, {
      data: {
        pendingBalanceUnits: "2000000",
        destinationAddress: G_WALLET,
        canWithdraw: true,
        withdrawals: [],
        ...overrides,
      },
      rewardSymbol: "USDC",
      confirming: false,
      withdrawing: false,
      onWithdraw: noop,
      onConfirm: noop,
      onCancel: noop,
      ...props,
    }),
  );
}

describe("AccountSheet (#39)", () => {
  const html = renderToStaticMarkup(
    createElement(AccountSheet, {
      open: true,
      onClose: noop,
      walletAddress: G_WALLET,
      totalEarned: "12.50",
      rewardSymbol: "USDC",
      submissionCount: 40,
      explorerUrl: "https://stellar.expert/explorer/testnet",
      country: null,
      gender: null,
      ageRange: null,
      showToast: noop,
      onDemographicsDeleted: noop,
      onLoggedOut: noop,
    }),
  );

  it("shows what was earned, not a withdrawable balance", () => {
    expect(html).toContain("Total earned");
    expect(html).toContain("12.50");
  });

  it("has no accrual or withdrawal step for an account without a legacy balance", () => {
    expect(html).not.toContain("Pending balance");
    expect(html).not.toContain("Min withdrawal");
    expect(html).not.toMatch(/>\s*Withdraw\s*</);
  });
});

describe("LegacyBalanceCard (#39)", () => {
  it("renders nothing once the legacy balance is zero", () => {
    expect(card({ pendingBalanceUnits: "0", canWithdraw: false })).toBe("");
  });

  it("offers a legacy balance below the retired minimum for withdrawal, with no minimum shown", () => {
    const html = card();
    expect(html).toContain("0.2");
    expect(html).toMatch(/>\s*Withdraw\s*</);
    expect(html).not.toContain("Min withdrawal");
    expect(html).toContain("GCKIPQ");
  });

  it("disables Withdraw when the server says it cannot be attempted", () => {
    expect(card({ canWithdraw: false })).toMatch(/<button[^>]*disabled=""[^>]*>\s*Withdraw\s*</);
  });

  it("asks for a wallet when the account has none bound", () => {
    const html = card({ destinationAddress: null, canWithdraw: false });
    expect(html).toContain("Connect your Stellar wallet to withdraw.");
  });

  it("confirms the amount and the bound wallet before sending", () => {
    const html = card({}, { confirming: true });
    expect(html).toContain("Confirm &amp; send");
    expect(html).toContain(G_WALLET);
  });
});
