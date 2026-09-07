import { Account, Asset, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMultisigFeeBump } from "../multisig-payout";
import {
  applyCoSignature,
  buildPayoutPayment,
  signAsPlatform,
  type PayoutCoSignRequest,
} from "../payout-envelope";
import { localPolicyCoSigner, resolvePayoutCoSigner } from "../payout-cosigner";

const policy = Keypair.random();
const platform = Keypair.random();
const usdc = new Asset("USDC", Keypair.random().publicKey());
const destination = Keypair.random().publicKey();

const baseEnv = {
  STELLAR_NETWORK: "testnet",
  STELLAR_POLICY_SIGNER_SECRET: policy.secret(),
  STELLAR_POLICY_SIGNER_PUBLIC: policy.publicKey(),
  STELLAR_ALLOW_LOCAL_COSIGNER: "true",
};

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

function paymentRequest(
  overrides: Partial<PayoutCoSignRequest> = {},
  amountUnits = 25_000_000n,
): PayoutCoSignRequest {
  const tx = buildPayoutPayment({
    sourceAccount: new Account(Keypair.random().publicKey(), "7"),
    destination,
    asset: usdc,
    amountUnits,
  });
  signAsPlatform(tx, platform);
  return {
    stage: "payment",
    xdr: tx.toXDR(),
    destination,
    amountUnits,
    submissionId: "sub-1",
    ...overrides,
  };
}

describe("localPolicyCoSigner", () => {
  it("signs an envelope whose payment matches the request", async () => {
    const request = paymentRequest();

    const result = await localPolicyCoSigner(policy).signPayout(request);

    expect(result.publicKey).toBe(policy.publicKey());
    const tx = TransactionBuilder.fromXDR(request.xdr, Networks.TESTNET);
    expect(policy.verify(tx.hash(), Buffer.from(result.signature, "base64"))).toBe(true);
  });

  it("signs the fee-bump envelope wrapping an already dual-signed payment", async () => {
    const request = paymentRequest();
    const inner = TransactionBuilder.fromXDR(request.xdr, Networks.TESTNET) as never;
    applyCoSignature(
      inner,
      await localPolicyCoSigner(policy).signPayout(request),
      policy.publicKey(),
    );
    const feeBump = buildMultisigFeeBump({
      feeSource: platform.publicKey(),
      innerTransaction: inner,
      requiredSignerPublicKeys: [platform.publicKey(), policy.publicKey()],
    });
    signAsPlatform(feeBump, platform);

    const result = await localPolicyCoSigner(policy).signPayout({
      stage: "fee_bump",
      xdr: feeBump.toXDR(),
      destination,
      amountUnits: 25_000_000n,
      submissionId: "sub-1",
    });

    expect(policy.verify(feeBump.hash(), Buffer.from(result.signature, "base64"))).toBe(true);
  });

  it("refuses an envelope paying a different destination than the request claims", async () => {
    const request = paymentRequest({ destination: Keypair.random().publicKey() });

    await expect(localPolicyCoSigner(policy).signPayout(request)).rejects.toThrow(
      /destination/i,
    );
  });

  it("refuses an envelope paying a different amount than the request claims", async () => {
    const request = paymentRequest({ amountUnits: 1n });

    await expect(localPolicyCoSigner(policy).signPayout(request)).rejects.toThrow(/amount/i);
  });

  it("refuses an envelope carrying more than the single payment operation", async () => {
    const source = new Account(Keypair.random().publicKey(), "7");
    const { Operation } = await import("@stellar/stellar-sdk");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination, asset: usdc, amount: "2.5000000" }))
      .addOperation(Operation.payment({ destination, asset: usdc, amount: "2.5000000" }))
      .setTimeout(180)
      .build();

    await expect(
      localPolicyCoSigner(policy).signPayout({
        stage: "payment",
        xdr: tx.toXDR(),
        destination,
        amountUnits: 25_000_000n,
        submissionId: "sub-1",
      }),
    ).rejects.toThrow(/exactly one payment/i);
  });
});

describe("resolvePayoutCoSigner", () => {
  it("returns the local co-signer when explicitly allowed on testnet", () => {
    expect(() => resolvePayoutCoSigner(baseEnv)).not.toThrow();
  });

  it("refuses the local co-signer on the public network", () => {
    expect(() =>
      resolvePayoutCoSigner({ ...baseEnv, STELLAR_NETWORK: "public" }),
    ).toThrow(/never.*public network/i);
  });

  it("refuses the local co-signer without an explicit opt-in", () => {
    expect(() =>
      resolvePayoutCoSigner({ ...baseEnv, STELLAR_ALLOW_LOCAL_COSIGNER: undefined }),
    ).toThrow(/STELLAR_ALLOW_LOCAL_COSIGNER/);
  });

  it("refuses a local secret that is not the configured co-signer key", () => {
    expect(() =>
      resolvePayoutCoSigner({
        ...baseEnv,
        STELLAR_POLICY_SIGNER_PUBLIC: Keypair.random().publicKey(),
      }),
    ).toThrow(/does not match/i);
  });

  it("fails closed when no co-signer is configured at all", () => {
    expect(() =>
      resolvePayoutCoSigner({ ...baseEnv, STELLAR_POLICY_SIGNER_SECRET: undefined }),
    ).toThrow(/no payout co-signer is configured/i);
  });
});
