import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// #28 — the sponsored onboarding envelope is wrapped in a fee bump at submit,
// with the sponsor as fee account. Real throwaway keys exercise the signing and
// hashing; Horizon is mocked at the `server()` boundary. Never funded.
const sponsorKp = Keypair.random();
process.env.STELLAR_PLATFORM_SECRET = sponsorKp.secret();
process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn() };
});

import { networkPassphrase, server } from "../config";
import {
  buildSponsoredTrustlineTx,
  prepareSponsoredTrustline,
  submitSponsoredTrustline,
  SPONSOR_MAX_FEE_PER_OP_STROOPS,
} from "../client";

const mockedServer = vi.mocked(server);

beforeEach(() => {
  mockedServer.mockReset();
});

/** The passphrase of the network this suite is not configured for. */
const otherNetwork = () => (networkPassphrase() === Networks.PUBLIC ? Networks.TESTNET : Networks.PUBLIC);

/** A Horizon account response holding `xlm`, with no subentries and nothing sponsored. */
function horizonAccount(pub: string, xlm = "100.0000000") {
  return Object.assign(new Account(pub, "1000"), {
    balances: [{ asset_type: "native", balance: xlm, selling_liabilities: "0.0000000" }],
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
  });
}

/**
 * A fake Horizon. `baseFee` is the network fee `fetchBaseFee` reports, `submit`
 * receives whatever is broadcast, and `missing` is an address that 404s.
 */
function fakeHorizon(
  o: {
    baseFee?: () => Promise<number>;
    submit?: ReturnType<typeof vi.fn>;
    sponsorXlm?: string;
    missing?: string;
  } = {},
) {
  return {
    loadAccount: vi.fn(async (pub: string) => {
      if (pub === o.missing) throw { response: { status: 404 } };
      return horizonAccount(pub, pub === sponsorKp.publicKey() ? o.sponsorXlm : undefined);
    }),
    fetchBaseFee: vi.fn(o.baseFee ?? (async () => 100)),
    submitTransaction: o.submit ?? vi.fn(async () => ({})),
    // Testnet and mainnet base reserve: 0.5 XLM.
    ledgers: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: [{ base_reserve_in_stroops: 5_000_000 }] }) }) }),
    }),
  };
}

/** The account-creation envelope for `recipient`, as the builder issues it, signed by `signers`. */
function onboardingEnvelope(
  recipient: Keypair,
  o: { baseFee?: string; passphrase?: string; signers?: Keypair[] } = {},
): Transaction {
  const r = recipient.publicKey();
  const tx = new TransactionBuilder(new Account(sponsorKp.publicKey(), "1000"), {
    fee: o.baseFee ?? "100",
    networkPassphrase: o.passphrase ?? networkPassphrase(),
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: r }))
    .addOperation(Operation.createAccount({ destination: r, startingBalance: "0" }))
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", process.env.STELLAR_USDC_ISSUER!), source: r }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: r }))
    .setTimeout(180)
    .build();
  tx.sign(...(o.signers ?? [sponsorKp, recipient]));
  return tx;
}

/** The one transaction `submit` broadcast. */
function broadcast(submit: ReturnType<typeof vi.fn>): FeeBumpTransaction {
  expect(submit).toHaveBeenCalledTimes(1);
  return submit.mock.calls[0][0] as FeeBumpTransaction;
}

/**
 * Horizon's rejection of a fee bump whose inner transaction failed. The shape
 * was captured from testnet on 2026-09-14: the outer code is always
 * `tx_fee_bump_inner_failed`, and what actually went wrong is in
 * `inner_transaction` and `operations`.
 */
function innerFailed(inner: string, operations?: string[]) {
  const result_codes = { transaction: "tx_fee_bump_inner_failed", inner_transaction: inner, ...(operations ? { operations } : {}) };
  return { response: { status: 400, data: { extras: { result_codes } } } };
}

describe("#28 — the sponsor pays the fee through a fee bump", () => {
  it("broadcasts the co-signed envelope inside a fee bump the sponsor signs and pays", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn(async () => ({}));
    mockedServer.mockReturnValue(fakeHorizon({ submit }) as never);
    const inner = onboardingEnvelope(recipient);

    await prepareSponsoredTrustline(inner.toXDR(), recipient.publicKey()).submit();

    const bump = broadcast(submit);
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(bump.feeSource).toBe(sponsorKp.publicKey());
    expect(bump.signatures).toHaveLength(1);
    expect(sponsorKp.verify(bump.hash(), bump.signatures[0].signature())).toBe(true);
    // The bytes the contributor signed ride inside unchanged, signatures and all.
    expect(bump.innerTransaction.toXDR()).toBe(inner.toXDR());
  });

  it("records the inner hash, which stays the same whatever the bump bids", async () => {
    const recipient = Keypair.random();
    const xdr = onboardingEnvelope(recipient).toXDR();

    const submitA = vi.fn(async () => ({}));
    mockedServer.mockReturnValue(fakeHorizon({ submit: submitA, baseFee: async () => 100 }) as never);
    const a = prepareSponsoredTrustline(xdr, recipient.publicKey());
    const sentA = await a.submit();

    const submitB = vi.fn(async () => ({}));
    mockedServer.mockReturnValue(fakeHorizon({ submit: submitB, baseFee: async () => 300 }) as never);
    const b = prepareSponsoredTrustline(xdr, recipient.publicKey());
    const sentB = await b.submit();

    expect(b.hash).toBe(a.hash);
    expect(broadcast(submitA).innerTransaction.hash().toString("hex")).toBe(a.hash);
    expect(sentA.hash).toBe(a.hash);
    expect(sentB.hash).toBe(a.hash);
    // Horizon answers a lookup by the inner hash with the fee bump that carried it,
    // so the ledger row never needs the outer one. It is still reported.
    expect(sentA.feeBumpHash).toBe(broadcast(submitA).hash().toString("hex"));
    expect(sentB.feeBumpHash).not.toBe(sentA.feeBumpHash);
  });

  it("bids the network fee at submit, across the inner operations plus the bump's own", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn(async () => ({}));
    mockedServer.mockReturnValue(fakeHorizon({ submit, baseFee: async () => 250 }) as never);

    await prepareSponsoredTrustline(onboardingEnvelope(recipient).toXDR(), recipient.publicKey()).submit();

    expect(broadcast(submit).fee).toBe(String(250 * 5));
  });

  it("never bids above the sponsor's per-operation bound", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn(async () => ({}));
    mockedServer.mockReturnValue(
      fakeHorizon({ submit, baseFee: async () => SPONSOR_MAX_FEE_PER_OP_STROOPS * 50 }) as never,
    );

    await prepareSponsoredTrustline(onboardingEnvelope(recipient).toXDR(), recipient.publicKey()).submit();

    expect(broadcast(submit).fee).toBe(String(SPONSOR_MAX_FEE_PER_OP_STROOPS * 5));
  });

  it("bids at least the inner rate when the fee lookup fails", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn(async () => ({}));
    mockedServer.mockReturnValue(
      fakeHorizon({ submit, baseFee: async () => { throw new Error("horizon down"); } }) as never,
    );

    const inner = onboardingEnvelope(recipient, { baseFee: "300" });
    await prepareSponsoredTrustline(inner.toXDR(), recipient.publicKey()).submit();

    expect(broadcast(submit).fee).toBe(String(300 * 5));
  });
});

describe("#28 — classifying a fee-bumped submit that failed", () => {
  /** Submit a valid envelope to a Horizon that throws `error`. */
  const submitWith = (error: unknown) => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      fakeHorizon({ submit: vi.fn(async () => { throw error; }) }) as never,
    );
    return submitSponsoredTrustline(onboardingEnvelope(recipient).toXDR(), recipient.publicKey());
  };

  it("reads a stale sequence from the inner result, and keeps it retryable", async () => {
    await expect(submitWith(innerFailed("tx_bad_seq"))).rejects.toMatchObject({
      code: "tx_bad_seq",
      retryable: true,
    });
  });

  it("reads op_low_reserve from the inner operations", async () => {
    await expect(submitWith(innerFailed("tx_failed", ["op_success", "op_low_reserve"]))).rejects.toMatchObject({
      code: "op_low_reserve",
      retryable: false,
    });
  });

  it("treats any other inner failure as a definite rejection, naming the inner code", async () => {
    const err = await submitWith(innerFailed("tx_failed", ["op_bad_auth"])).catch((e) => e);
    expect(err).toMatchObject({ code: "sponsor_tx_rejected", retryable: false });
    expect(err.message).toContain("op_bad_auth");
  });

  it("maps a sponsor that cannot pay the bump's fee to sponsor_low_reserve", async () => {
    const error = { response: { status: 400, data: { extras: { result_codes: { transaction: "tx_insufficient_balance" } } } } };
    await expect(submitWith(error)).rejects.toMatchObject({ code: "sponsor_low_reserve", retryable: false });
  });

  it("still treats a timeout as submission_unknown", async () => {
    await expect(submitWith({ response: { status: 504, data: {} } })).rejects.toMatchObject({
      code: "submission_unknown",
    });
  });
});

describe("#28 — refusing an envelope the contributor did not validly sign", () => {
  /** Assert `prepareSponsoredTrustline` refuses `signedXdr` as `invalid_sponsor_tx`. */
  const rejects = (signedXdr: string, recipient: Keypair) =>
    expect(() => prepareSponsoredTrustline(signedXdr, recipient.publicKey())).toThrow(
      expect.objectContaining({ code: "invalid_sponsor_tx", retryable: false }),
    );

  it("rejects an envelope the contributor never signed", () => {
    const recipient = Keypair.random();
    rejects(onboardingEnvelope(recipient, { signers: [sponsorKp] }).toXDR(), recipient);
  });

  it("rejects a contributor signature made for the other network", () => {
    const recipient = Keypair.random();
    const tx = onboardingEnvelope(recipient, { signers: [sponsorKp] });
    const elsewhere = new Transaction(tx.toEnvelope(), otherNetwork());
    tx.addDecoratedSignature(recipient.signDecorated(elsewhere.hash()));

    rejects(tx.toXDR(), recipient);
  });

  it("rejects an envelope built and signed for the other network", () => {
    const recipient = Keypair.random();
    rejects(onboardingEnvelope(recipient, { passphrase: otherNetwork() }).toXDR(), recipient);
  });

  it("rejects a third signature riding along", () => {
    const recipient = Keypair.random();
    rejects(onboardingEnvelope(recipient, { signers: [sponsorKp, recipient, Keypair.random()] }).toXDR(), recipient);
  });

  it("rejects a fee bump from the client — only the server wraps", () => {
    const recipient = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(
      recipient,
      "200",
      onboardingEnvelope(recipient),
      networkPassphrase(),
    );
    bump.sign(recipient);
    rejects(bump.toXDR(), recipient);
  });
});

describe("#28 — building for a fee bump", () => {
  it("asks the contributor to sign the minimum inner fee, whatever the network is bidding", async () => {
    const recipient = Keypair.random().publicKey();
    mockedServer.mockReturnValue(
      fakeHorizon({ missing: recipient, baseFee: async () => SPONSOR_MAX_FEE_PER_OP_STROOPS * 50 }) as never,
    );

    const { xdr } = await buildSponsoredTrustlineTx(recipient);
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;

    // Freighter shows this number. The bid itself is made by the bump at submit.
    expect(Number(tx.fee)).toBe(100 * tx.operations.length);
  });

  // The sponsor's own two base reserves (1 XLM) are locked. An account-creation
  // sponsorship adds three (1.5 XLM), and the bump pays for five operations.
  it("counts the fee bump's own operation in what the sponsor must cover", async () => {
    const recipient = Keypair.random().publicKey();

    mockedServer.mockReturnValue(fakeHorizon({ missing: recipient, sponsorXlm: "2.5000400" }) as never);
    await expect(buildSponsoredTrustlineTx(recipient)).rejects.toMatchObject({ code: "sponsor_low_reserve" });

    mockedServer.mockReturnValue(fakeHorizon({ missing: recipient, sponsorXlm: "2.5000500" }) as never);
    await expect(buildSponsoredTrustlineTx(recipient)).resolves.toMatchObject({ kind: "account+trustline" });
  });
});
