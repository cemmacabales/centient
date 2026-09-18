import { describe, it, expect } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  WALLET_LINK_ACTION,
  buildChallengeMessage,
} from "@/lib/stellar/challenge-message";
import * as harness from "@/lib/stellar/freighter-proof";

describe("buildChallengeMessage", () => {
  it("produces exactly the bytes #24 proved Freighter signs", () => {
    const address = Keypair.random().publicKey();
    const message = buildChallengeMessage({
      address,
      networkPassphrase: Networks.TESTNET,
      nonce: "00112233445566778899aabbccddeeff",
      issuedAt: new Date("2026-09-14T04:16:00.000Z"),
      expiresAt: new Date("2026-09-14T04:21:00.000Z"),
    });

    expect(message).toBe(
      [
        "Centient: prove you control this Stellar address.",
        "",
        `Address: ${address}`,
        "Network: Test SDF Network ; September 2015",
        "Action: prove-stellar-address",
        "Nonce: 00112233445566778899aabbccddeeff",
        "Issued At: 2026-09-14T04:16:00.000Z",
        "Expires At: 2026-09-14T04:21:00.000Z",
      ].join("\n"),
    );
  });

  it("never normalizes the address", () => {
    const address = Keypair.random().publicKey();
    const message = buildChallengeMessage({
      address: address.toLowerCase(),
      networkPassphrase: Networks.TESTNET,
      nonce: "ab",
      issuedAt: new Date(0),
      expiresAt: new Date(CHALLENGE_TTL_MS),
    });
    expect(message).toContain(`Address: ${address.toLowerCase()}`);
    expect(message).not.toContain(address);
  });
});

describe("constants", () => {
  it("pins the lifetime and both action strings", () => {
    expect(CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
    expect(PROOF_ACTION).toBe("prove-stellar-address");
    expect(WALLET_LINK_ACTION).toBe("link-payout-address");
  });
});

describe("the #24 harness", () => {
  it("shares the production format rather than keeping its own copy", () => {
    expect(harness.buildChallengeMessage).toBe(buildChallengeMessage);
    expect(harness.CHALLENGE_TTL_MS).toBe(CHALLENGE_TTL_MS);
    expect(harness.PROOF_ACTION).toBe(PROOF_ACTION);
  });
});
