// #35: the contributor is resolved from the wallet-native session. The server
// refuses work to an account without a bound Stellar wallet (app/api/task);
// this is the client half — where /api/auth/me sends a session.
import { describe, it, expect } from "vitest";
import { sessionStep } from "@/lib/contributor-session";

const G = "GD2MXKNHV4JZ5MRHYPIEOYUBZMDKHAIE4CVV3IKBQWRCIYF2RPSLNFLO";

describe("sessionStep", () => {
  it("sends a wallet-authenticated contributor on toward the ranking surface", () => {
    expect(sessionStep({ authenticated: true, userId: "u1", wallet: G })).toEqual({ step: "payout_setup", wallet: G });
  });

  it("does not require an email to reach the ranking surface", () => {
    expect(sessionStep({ authenticated: true, userId: "u1", wallet: G, email: null })).toEqual({
      step: "payout_setup",
      wallet: G,
    });
  });

  it.each([
    ["no wallet", null],
    ["a missing wallet", undefined],
    ["a legacy EVM address", "0x52908400098527886E0F7030069857D2E4169EE7"],
    ["a malformed address", "GNOTAWALLET"],
  ])("serves no work to an account with %s — it claims a wallet first", (_label, wallet) => {
    expect(sessionStep({ authenticated: true, userId: "u1", wallet })).toEqual({ step: "claim_wallet" });
  });

  it.each([
    ["an unauthenticated answer", { authenticated: false }],
    ["an empty body", {}],
  ])("returns %s to login", (_label, me) => {
    expect(sessionStep(me)).toEqual({ step: "login" });
  });
});
