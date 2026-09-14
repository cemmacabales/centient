import { Account, Asset, Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { buildSponsoredRecipientTx } from "../sponsored-recipient";

const USDC_ISSUER = Keypair.random().publicKey();
const usdc = new Asset("USDC", USDC_ISSUER);

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

describe("buildSponsoredRecipientTx", () => {
  it("builds the exact CAP-33 account + USDC trustline sandwich", () => {
    const sponsor = Keypair.random();
    const recipient = Keypair.random();

    const tx = buildSponsoredRecipientTx({
      sponsorAccount: new Account(sponsor.publicKey(), "41"),
      recipientPublicKey: recipient.publicKey(),
      asset: usdc,
      fee: "100",
    });

    expect(tx.source).toBe(sponsor.publicKey());
    expect(tx.operations.map((operation) => operation.type)).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    expect(tx.operations[0]).toMatchObject({
      sponsoredId: recipient.publicKey(),
    });
    expect(tx.operations[1]).toMatchObject({
      destination: recipient.publicKey(),
      startingBalance: "0.0000000",
    });
    expect(tx.operations[2]).toMatchObject({
      source: recipient.publicKey(),
      line: { code: "USDC", issuer: USDC_ISSUER },
    });
    expect(tx.operations[3]).toMatchObject({ source: recipient.publicKey() });
    expect(Number(tx.timeBounds?.maxTime)).toBeGreaterThan(0);
  });

  it("rejects a malformed recipient before building an envelope", () => {
    expect(() =>
      buildSponsoredRecipientTx({
        sponsorAccount: new Account(Keypair.random().publicKey(), "0"),
        recipientPublicKey: "not-a-stellar-account",
        asset: usdc,
      }),
    ).toThrow(/valid Stellar public key/i);
  });
});
