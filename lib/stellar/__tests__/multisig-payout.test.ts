import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Transaction,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addIndependentSignatures,
  buildMultisigFeeBump,
  buildUsdcPaymentTx,
  minimumFeeBumpBaseFee,
} from "../multisig-payout";

const USDC_ISSUER = Keypair.random().publicKey();
const usdc = new Asset("USDC", USDC_ISSUER);

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

function verifySignatures(
  tx: Transaction | FeeBumpTransaction,
  signers: readonly Keypair[],
) {
  expect(tx.signatures).toHaveLength(signers.length);
  for (const signer of signers) {
    const matchingSignature = tx.signatures.find((signature) =>
      signature.hint().equals(signer.signatureHint()),
    );
    expect(matchingSignature).toBeDefined();
    expect(signer.verify(tx.hash(), matchingSignature!.signature())).toBe(true);
  }
}

describe("addIndependentSignatures", () => {
  it("collects separately produced signatures over one unchanged envelope", () => {
    const source = Keypair.random();
    const cosigner = Keypair.random();
    const destination = Keypair.random().publicKey();
    const tx = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "9"),
      destination,
      asset: usdc,
      amountUnits: 1_250_000n,
    });
    const unsignedEnvelope = tx.toXDR();

    addIndependentSignatures(tx, [source, cosigner]);

    expect(unsignedEnvelope).not.toBe(tx.toXDR());
    verifySignatures(tx, [source, cosigner]);
  });

  it("rejects duplicate keys instead of counting one party twice", () => {
    const source = Keypair.random();
    const tx = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "9"),
      destination: Keypair.random().publicKey(),
      asset: usdc,
      amountUnits: 1n,
    });

    expect(() => addIndependentSignatures(tx, [source, source])).toThrow(
      /independent signer keys/i,
    );
    expect(tx.signatures).toHaveLength(0);
  });
});

describe("buildUsdcPaymentTx", () => {
  it("preserves the 7-decimal unit boundary and sets time bounds", () => {
    const source = Keypair.random();
    const destination = Keypair.random().publicKey();

    const tx = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "123"),
      destination,
      asset: usdc,
      amountUnits: 12_345_678n,
      fee: "250",
    });

    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({
      type: "payment",
      destination,
      amount: "1.2345678",
      asset: { code: "USDC", issuer: USDC_ISSUER },
    });
    expect(tx.fee).toBe("250");
    expect(Number(tx.timeBounds?.maxTime)).toBeGreaterThan(0);
  });

  it("rejects zero-value payouts", () => {
    expect(() =>
      buildUsdcPaymentTx({
        sourceAccount: new Account(Keypair.random().publicKey(), "0"),
        destination: Keypair.random().publicKey(),
        asset: usdc,
        amountUnits: 0n,
      }),
    ).toThrow(/positive/i);
  });
});

describe("fee bump", () => {
  it("derives a per-operation fee ceiling with the network minimum as a floor", () => {
    const source = Keypair.random();
    const oneOperation = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "0"),
      destination: Keypair.random().publicKey(),
      asset: usdc,
      amountUnits: 1n,
      fee: "250",
    });
    const belowNetworkMinimum = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "1"),
      destination: Keypair.random().publicKey(),
      asset: usdc,
      amountUnits: 1n,
      fee: "1",
    });

    expect(minimumFeeBumpBaseFee(oneOperation)).toBe("250");
    expect(minimumFeeBumpBaseFee(belowNetworkMinimum, "99")).toBe(BASE_FEE);
    expect(minimumFeeBumpBaseFee(oneOperation, "400")).toBe("400");
  });

  it("wraps a two-signature payment and keeps inner and outer signatures distinct", () => {
    const source = Keypair.random();
    const cosigner = Keypair.random();
    const inner = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "12"),
      destination: Keypair.random().publicKey(),
      asset: usdc,
      amountUnits: 5_000_000n,
      fee: "100",
    });
    addIndependentSignatures(inner, [source, cosigner]);

    const feeBump = buildMultisigFeeBump({
      feeSource: source.publicKey(),
      baseFee: "100",
      innerTransaction: inner,
      requiredSignerPublicKeys: [source.publicKey(), cosigner.publicKey()],
    });
    addIndependentSignatures(feeBump, [source, cosigner]);

    expect(feeBump.feeSource).toBe(source.publicKey());
    expect(feeBump.innerTransaction.toXDR()).toBe(inner.toXDR());
    verifySignatures(feeBump.innerTransaction, [source, cosigner]);
    verifySignatures(feeBump, [source, cosigner]);
  });

  it("refuses to wrap an under-signed payment", () => {
    const source = Keypair.random();
    const inner = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "12"),
      destination: Keypair.random().publicKey(),
      asset: usdc,
      amountUnits: 1n,
    });
    addIndependentSignatures(inner, [source], 1);

    expect(() =>
      buildMultisigFeeBump({
        feeSource: source.publicKey(),
        baseFee: "100",
        innerTransaction: inner,
        requiredSignerPublicKeys: [source.publicKey(), Keypair.random().publicKey()],
      }),
    ).toThrow(/at least 2 signatures/i);
  });

  it("refuses two signatures when one is not from the required signer set", () => {
    const source = Keypair.random();
    const requiredCosigner = Keypair.random();
    const intruder = Keypair.random();
    const inner = buildUsdcPaymentTx({
      sourceAccount: new Account(source.publicKey(), "12"),
      destination: Keypair.random().publicKey(),
      asset: usdc,
      amountUnits: 1n,
    });
    addIndependentSignatures(inner, [source, intruder]);

    expect(() =>
      buildMultisigFeeBump({
        feeSource: source.publicKey(),
        innerTransaction: inner,
        requiredSignerPublicKeys: [
          source.publicKey(),
          requiredCosigner.publicKey(),
        ],
      }),
    ).toThrow(/required signer/i);
  });
});
