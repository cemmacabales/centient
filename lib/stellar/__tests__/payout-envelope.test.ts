import { Account, Asset, Keypair, Transaction } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMultisigFeeBump } from "../multisig-payout";
import {
  applyCoSignature,
  assertPayoutFullySigned,
  buildPayoutPayment,
  signAsPlatform,
} from "../payout-envelope";

const usdc = new Asset("USDC", Keypair.random().publicKey());

const platform = Keypair.random();
const coSigner = Keypair.random();
const stranger = Keypair.random();

const destination = Keypair.random().publicKey();

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

function hotAccount(sequence = "42") {
  return new Account(Keypair.random().publicKey(), sequence);
}

function coSignatureOver(tx: Transaction, signer: Keypair) {
  return {
    publicKey: signer.publicKey(),
    signature: signer.sign(tx.hash()).toString("base64"),
  };
}

describe("buildPayoutPayment", () => {
  it("carries the exact stroop amount and destination", () => {
    const tx = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 25_000_000n,
    });

    const op = tx.operations[0] as { type: string; destination: string; amount: string };
    expect(op.type).toBe("payment");
    expect(op.destination).toBe(destination);
    expect(op.amount).toBe("2.5000000");
  });

  it("rejects a non-positive amount before building an envelope", () => {
    expect(() =>
      buildPayoutPayment({
        sourceAccount: hotAccount(),
        destination,
        asset: usdc,
        amountUnits: 0n,
      }),
    ).toThrow(/must be positive/i);
  });

  it("rejects a malformed destination before building an envelope", () => {
    expect(() =>
      buildPayoutPayment({
        sourceAccount: hotAccount(),
        destination: "not-an-address",
        asset: usdc,
        amountUnits: 1n,
      }),
    ).toThrow(/valid Stellar public key/i);
  });

  it("builds an unsigned envelope — the platform signature is a separate step", () => {
    const tx = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    expect(tx.signatures).toHaveLength(0);
  });
});

describe("applyCoSignature", () => {
  function signedPayment() {
    const tx = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    signAsPlatform(tx, platform);
    return tx;
  }

  it("merges a valid co-signature into the platform-signed envelope", () => {
    const tx = signedPayment();

    applyCoSignature(tx, coSignatureOver(tx, coSigner), coSigner.publicKey());

    expect(tx.signatures).toHaveLength(2);
    expect(
      tx.signatures.some((s) => coSigner.verify(tx.hash(), s.signature())),
    ).toBe(true);
  });

  it("rejects a signature from a signer other than the configured co-signer", () => {
    const tx = signedPayment();

    expect(() =>
      applyCoSignature(tx, coSignatureOver(tx, stranger), coSigner.publicKey()),
    ).toThrow(/not the configured co-signer/i);
  });

  it("rejects a signature that does not verify against this envelope", () => {
    const tx = signedPayment();
    const forged = {
      publicKey: coSigner.publicKey(),
      signature: Buffer.alloc(64).toString("base64"),
    };

    expect(() => applyCoSignature(tx, forged, coSigner.publicKey())).toThrow(
      /does not verify/i,
    );
  });

  it("rejects a co-signature produced over a different transaction", () => {
    // The substitution attack: the co-signer approves some other payout and we
    // are handed that signature for this one. Verification is against OUR hash,
    // so a signature over any other envelope can never be merged.
    const ours = signedPayment();
    const theirs = signedPayment();

    expect(() =>
      applyCoSignature(ours, coSignatureOver(theirs, coSigner), coSigner.publicKey()),
    ).toThrow(/does not verify/i);
  });

  it("leaves the envelope untouched when the co-signature is rejected", () => {
    const tx = signedPayment();

    expect(() =>
      applyCoSignature(tx, coSignatureOver(tx, stranger), coSigner.publicKey()),
    ).toThrow();
    expect(tx.signatures).toHaveLength(1);
  });
});

describe("assertPayoutFullySigned", () => {
  function dualSigned() {
    const tx = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    signAsPlatform(tx, platform);
    applyCoSignature(tx, coSignatureOver(tx, coSigner), coSigner.publicKey());
    return tx;
  }

  it("accepts an envelope carrying both required signatures", () => {
    expect(() =>
      assertPayoutFullySigned(dualSigned(), [platform.publicKey(), coSigner.publicKey()]),
    ).not.toThrow();
  });

  it("rejects an envelope the platform alone signed", () => {
    const tx = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    signAsPlatform(tx, platform);

    expect(() =>
      assertPayoutFullySigned(tx, [platform.publicKey(), coSigner.publicKey()]),
    ).toThrow(/missing a valid required signer/i);
  });

  it("rejects an envelope signed twice by the same key", () => {
    // Two signatures is not two parties. A doubled platform signature must never
    // satisfy the 2-of-3 threshold.
    const tx = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    signAsPlatform(tx, platform);
    tx.addSignature(platform.publicKey(), platform.sign(tx.hash()).toString("base64"));

    expect(() =>
      assertPayoutFullySigned(tx, [platform.publicKey(), coSigner.publicKey()]),
    ).toThrow(/missing a valid required signer/i);
  });

  it("rejects a required signer list that is not two distinct keys", () => {
    expect(() =>
      assertPayoutFullySigned(dualSigned(), [platform.publicKey(), platform.publicKey()]),
    ).toThrow(/distinct/i);
  });
});

describe("fee-bump envelopes", () => {
  it("merges and verifies a co-signature on a fee-bump envelope", () => {
    const inner = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    signAsPlatform(inner, platform);
    applyCoSignature(inner, coSignatureOver(inner, coSigner), coSigner.publicKey());

    const feeBump = buildMultisigFeeBump({
      feeSource: platform.publicKey(),
      innerTransaction: inner,
      requiredSignerPublicKeys: [platform.publicKey(), coSigner.publicKey()],
    });
    signAsPlatform(feeBump, platform);
    applyCoSignature(
      feeBump,
      { publicKey: coSigner.publicKey(), signature: coSigner.sign(feeBump.hash()).toString("base64") },
      coSigner.publicKey(),
    );

    expect(feeBump.signatures).toHaveLength(2);
    expect(() =>
      assertPayoutFullySigned(feeBump, [platform.publicKey(), coSigner.publicKey()]),
    ).not.toThrow();
  });

  it("rejects a fee-bump envelope the platform alone signed", () => {
    const inner = buildPayoutPayment({
      sourceAccount: hotAccount(),
      destination,
      asset: usdc,
      amountUnits: 1n,
    });
    signAsPlatform(inner, platform);
    applyCoSignature(inner, coSignatureOver(inner, coSigner), coSigner.publicKey());

    const feeBump = buildMultisigFeeBump({
      feeSource: platform.publicKey(),
      innerTransaction: inner,
      requiredSignerPublicKeys: [platform.publicKey(), coSigner.publicKey()],
    });
    signAsPlatform(feeBump, platform);

    expect(() =>
      assertPayoutFullySigned(feeBump, [platform.publicKey(), coSigner.publicKey()]),
    ).toThrow(/missing a valid required signer/i);
  });
});
