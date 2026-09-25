import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { verifySettledPayout, type ExpectedPayout } from "../payout-verify";

// #40 D4 — what a confirmed payout actually paid.
//
// Horizon's `successful` says an envelope applied, not what it applied. These
// build real envelopes, the shape `submitMultisigPayout` submits and every way
// one could differ from the submission it settled, and check the verifier reads
// each difference off the envelope itself.

const payoutAccount = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const usdc = new Asset("USDC", Keypair.random().publicKey());
const AMOUNT = 2_500_000n; // 0.25 USDC

const expected: ExpectedPayout = { payoutAccount, destination, amountUnits: AMOUNT, asset: usdc };

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
});

interface Shape {
  innerSource?: string;
  feeSource?: string | null; // null: submitted bare, with no fee bump
  operations?: ReturnType<typeof Operation.payment>[];
}

const pay = (over: Partial<Parameters<typeof Operation.payment>[0]> = {}) =>
  Operation.payment({ destination, asset: usdc, amount: "0.2500000", ...over });

/** The envelope as Horizon returns it in `envelope_xdr`. */
function envelope({ innerSource = payoutAccount, feeSource = payoutAccount, operations = [pay()] }: Shape = {}) {
  const builder = new TransactionBuilder(new Account(innerSource, "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of operations) builder.addOperation(op);
  const inner: Transaction = builder.setTimeout(180).build();
  if (feeSource === null) return inner.toXDR();
  return TransactionBuilder.buildFeeBumpTransaction(feeSource, "200", inner, Networks.TESTNET).toXDR();
}

describe("verifySettledPayout", () => {
  it("accepts the envelope the payout submitter builds", () => {
    expect(verifySettledPayout(envelope(), expected)).toEqual({ ok: true });
  });

  it("accepts a payment op that names the payout account as its source", () => {
    expect(verifySettledPayout(envelope({ operations: [pay({ source: payoutAccount })] }), expected)).toEqual({
      ok: true,
    });
  });

  const other = Keypair.random().publicKey();
  it.each<[string, Shape, RegExp]>([
    ["a different destination", { operations: [pay({ destination: other })] }, /destination/],
    ["a different amount", { operations: [pay({ amount: "0.2500001" })] }, /amount/],
    ["a different asset code", { operations: [pay({ asset: new Asset("USDX", usdc.getIssuer()) })] }, /asset/],
    ["a different issuer", { operations: [pay({ asset: new Asset("USDC", other) })] }, /asset/],
    ["native XLM", { operations: [pay({ asset: Asset.native() })] }, /asset/],
    ["another inner source", { innerSource: other }, /source/],
    ["a payment op sourced from another account", { operations: [pay({ source: other })] }, /source/],
    ["a fee bump someone else paid for", { feeSource: other }, /fee source/],
    ["no fee bump at all", { feeSource: null }, /fee bump/],
    ["two payment ops", { operations: [pay(), pay()] }, /exactly one payment/],
    [
      "a payment plus another op",
      { operations: [pay(), Operation.bumpSequence({ bumpTo: "100" })] },
      /exactly one payment/,
    ],
  ])("flags %s", (_label, shape, reason) => {
    const result = verifySettledPayout(envelope(shape), expected);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.mismatches.join("; ")).toMatch(reason);
  });

  it("reports every mismatch, not only the first", () => {
    const result = verifySettledPayout(
      envelope({ feeSource: Keypair.random().publicKey(), operations: [pay({ destination: Keypair.random().publicKey(), amount: "9" })] }),
      expected,
    );

    expect(result.ok ? [] : result.mismatches).toHaveLength(3);
  });

  it("flags an envelope that does not decode", () => {
    const result = verifySettledPayout("not-xdr", expected);

    expect(result).toEqual({ ok: false, mismatches: [expect.stringMatching(/decode/)] });
  });
});
