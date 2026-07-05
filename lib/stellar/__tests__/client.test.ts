import { describe, it, expect, beforeEach, vi } from "vitest";
import { Account, Asset, Keypair, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

// Real throwaway keypairs — only the signing/address machinery is exercised; all
// network I/O is mocked at the `server()` boundary below. Never funded.
const platformKp = Keypair.random();
const destPub = Keypair.random().publicKey();
process.env.STELLAR_PLATFORM_SECRET = platformKp.secret();
// USDC is an issued asset: the client builds a real payment against this issuer.
process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

// Mock only `server()`; keep the real config helpers (passphrase, asset,
// conversions) so payUsdc builds a genuine, signed transaction against a fake
// Horizon.
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn() };
});

import { server } from "../config";
import { payUsdc, getTxStatus, StellarPaymentError, buildSponsoredTrustlineTx, submitSponsoredTrustline } from "../client";

const mockedServer = vi.mocked(server);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function horizonError(result_codes: { transaction?: string; operations?: string[] }) {
  return { response: { data: { extras: { result_codes } } } };
}
const badSeqError = () => horizonError({ transaction: "tx_bad_seq" });
const opNoDestError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_no_destination"] });
const opNoTrustError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_no_trust"] });

type FakeServer = {
  loadAccount: ReturnType<typeof vi.fn>;
  fetchBaseFee: ReturnType<typeof vi.fn>;
  submitTransaction: ReturnType<typeof vi.fn>;
  transactions: () => { transaction: () => { call: () => Promise<unknown> } };
};

function makeServer(opts: {
  submitTransaction?: ReturnType<typeof vi.fn>;
  call?: () => Promise<unknown>;
}): FakeServer {
  return {
    loadAccount: vi.fn(async (pub: string) => new Account(pub, "1000")),
    fetchBaseFee: vi.fn(async () => 100),
    submitTransaction: opts.submitTransaction ?? vi.fn(async () => ({ hash: "HASH" })),
    transactions: () => ({
      transaction: () => ({ call: opts.call ?? (async () => ({ successful: true })) }),
    }),
  };
}

beforeEach(() => {
  mockedServer.mockReset();
});

describe("payUsdc", () => {
  it("builds, signs, submits and returns the tx hash on success", async () => {
    const submit = vi.fn(async () => ({ hash: "HASH_OK" }));
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    const res = await payUsdc(destPub, 15_000_000n);

    expect(res).toEqual({ hash: "HASH_OK" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once on tx_bad_seq (reload + resubmit) then succeeds", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(badSeqError())
      .mockResolvedValueOnce({ hash: "HASH_RETRY" });
    const srv = makeServer({ submitTransaction: submit });
    mockedServer.mockReturnValue(srv as never);

    const res = await payUsdc(destPub, 1n);

    expect(res.hash).toBe("HASH_RETRY");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(srv.loadAccount).toHaveBeenCalledTimes(2); // fresh sequence on retry
  });

  it("surfaces a second consecutive tx_bad_seq as a retryable StellarPaymentError (no infinite retry, requeue-able)", async () => {
    const submit = vi.fn().mockRejectedValue(badSeqError());
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    // After the one in-call reload+resubmit still hits tx_bad_seq, payUsdc gives up
    // but classifies it so the worker requeues (backoff via the job queue) instead of
    // treating an opaque raw Horizon error as a generic failure.
    await expect(payUsdc(destPub, 1n)).rejects.toMatchObject({
      name: "StellarPaymentError",
      code: "tx_bad_seq",
      retryable: true,
    });
    expect(submit).toHaveBeenCalledTimes(2); // initial + one in-call retry, then give up
  });

  it("throws a non-retryable StellarPaymentError on op_no_destination and never retries", async () => {
    const submit = vi.fn().mockRejectedValue(opNoDestError());
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await expect(payUsdc(destPub, 1n)).rejects.toMatchObject({
      name: "StellarPaymentError",
      code: "op_no_destination",
      retryable: false,
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable StellarPaymentError on op_no_trust (no USDC trustline) and never retries", async () => {
    const submit = vi.fn().mockRejectedValue(opNoTrustError());
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await expect(payUsdc(destPub, 1n)).rejects.toMatchObject({
      name: "StellarPaymentError",
      code: "op_no_trust",
      retryable: false,
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive amount without touching the network", async () => {
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await expect(payUsdc(destPub, 0n)).rejects.toBeInstanceOf(StellarPaymentError);
    await expect(payUsdc(destPub, -5n)).rejects.toBeInstanceOf(StellarPaymentError);
    expect(submit).not.toHaveBeenCalled();
  });

  it("serializes concurrent payouts under the mutex (max concurrency 1)", async () => {
    let active = 0;
    let maxActive = 0;
    const submit = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return { hash: "H" };
    });
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await Promise.all(Array.from({ length: 8 }, () => payUsdc(destPub, 1n)));

    expect(maxActive).toBe(1);
    expect(submit).toHaveBeenCalledTimes(8);
  });
});

describe("getTxStatus", () => {
  it("maps successful=true to confirmed", async () => {
    mockedServer.mockReturnValue(makeServer({ call: async () => ({ successful: true }) }) as never);
    expect(await getTxStatus("h")).toBe("confirmed");
  });

  it("maps successful=false to failed", async () => {
    mockedServer.mockReturnValue(makeServer({ call: async () => ({ successful: false }) }) as never);
    expect(await getTxStatus("h")).toBe("failed");
  });

  it("maps a 404 to not_found", async () => {
    mockedServer.mockReturnValue(
      makeServer({
        call: async () => {
          throw { response: { status: 404 } };
        },
      }) as never,
    );
    expect(await getTxStatus("h")).toBe("not_found");
  });

  it("rethrows non-404 errors", async () => {
    mockedServer.mockReturnValue(
      makeServer({
        call: async () => {
          throw { response: { status: 500 } };
        },
      }) as never,
    );
    await expect(getTxStatus("h")).rejects.toMatchObject({ response: { status: 500 } });
  });
});

// Horizon 404 shape (account not found).
const notFound = () => ({ response: { status: 404 } });

describe("buildSponsoredTrustlineTx", () => {
  it("builds a begin/changeTrust/end sandwich for an existing account", async () => {
    const recipient = Keypair.random().publicKey();
    const srv = makeServer({});
    // platform load (seq) + recipient load (exists) both succeed.
    srv.loadAccount = vi.fn(async (pub: string) => new Account(pub, "1000"));
    mockedServer.mockReturnValue(srv as never);

    const { xdr, kind } = await buildSponsoredTrustlineTx(recipient);
    expect(kind).toBe("trustline");

    // No STELLAR_NETWORK set → networkPassphrase() defaults to testnet.
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;
    expect(tx.operations.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    // sponsor = platform (tx source); sponsored + trustline owner = recipient.
    expect(tx.source).toBe(platformKp.publicKey());
    expect((tx.operations[0] as { sponsoredId: string }).sponsoredId).toBe(recipient);
    expect(tx.operations[1].source).toBe(recipient);
    expect(tx.operations[2].source).toBe(recipient);
  });

  it("prepends createAccount(recipient, '0') when the account does not exist", async () => {
    const recipient = Keypair.random().publicKey();
    const srv = makeServer({});
    srv.loadAccount = vi.fn(async (pub: string) => {
      if (pub === recipient) throw notFound();
      return new Account(pub, "1000");
    });
    mockedServer.mockReturnValue(srv as never);

    const { xdr, kind } = await buildSponsoredTrustlineTx(recipient);
    expect(kind).toBe("account+trustline");
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;
    expect(tx.operations.map((o) => o.type)).toEqual([
      "beginSponsoringFutureReserves",
      "createAccount",
      "changeTrust",
      "endSponsoringFutureReserves",
    ]);
    expect((tx.operations[1] as { destination: string; startingBalance: string }).destination).toBe(recipient);
    // The Stellar SDK normalizes amounts to 7 decimal places when decoding from XDR.
    expect((tx.operations[1] as { startingBalance: string }).startingBalance).toBe("0.0000000");
  });
});

import { networkPassphrase } from "../config";

// Build a valid recipient-signed-looking sandwich XDR for submit tests. Platform
// + recipient both sign so the envelope parses; Horizon is mocked so real
// signature verification never runs.
function sandwichXdr(recipient: Keypair): string {
  const account = new Account(platformKp.publicKey(), "1000");
  const tx = new TransactionBuilder(account, {
    fee: "300",
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey() }))
    .addOperation(Operation.changeTrust({ asset: makeUsdc(), source: recipient.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }))
    .setTimeout(180)
    .build();
  tx.sign(platformKp, recipient);
  return tx.toXDR();
}
function makeUsdc() {
  return new Asset("USDC", process.env.STELLAR_USDC_ISSUER!);
}
// A tampered envelope: an extra payment op the platform never sponsored.
function tamperedXdr(recipient: Keypair): string {
  const account = new Account(platformKp.publicKey(), "1000");
  const tx = new TransactionBuilder(account, {
    fee: "200",
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey() }))
    .addOperation(Operation.payment({ destination: recipient.publicKey(), asset: makeUsdc(), amount: "100" }))
    .setTimeout(180)
    .build();
  tx.sign(platformKp);
  return tx.toXDR();
}
// A sandwich where endSponsoringFutureReserves.source is a DIFFERENT key than the
// sponsored recipient. Fix 4 ensures this is rejected before submit.
function wrongEndSponsoringXdr(recipient: Keypair): string {
  const wrongKey = Keypair.random().publicKey();
  const account = new Account(platformKp.publicKey(), "1000");
  const tx = new TransactionBuilder(account, {
    fee: "300",
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey() }))
    .addOperation(Operation.changeTrust({ asset: makeUsdc(), source: recipient.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: wrongKey }))
    .setTimeout(180)
    .build();
  tx.sign(platformKp, recipient);
  return tx.toXDR();
}
// A crafted 4-op sandwich where createAccount targets a DIFFERENT account than
// the sponsoredId (and changeTrust.source). This must be rejected by
// assertSponsoredTrustlineShape before submit.
function mismatchedCreateAccountXdr(recipient: Keypair): string {
  const otherAccount = Keypair.random().publicKey();
  const account = new Account(platformKp.publicKey(), "1000");
  const tx = new TransactionBuilder(account, {
    fee: "300",
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey() }))
    .addOperation(Operation.createAccount({ destination: otherAccount, startingBalance: "0" }))
    .addOperation(Operation.changeTrust({ asset: makeUsdc(), source: recipient.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }))
    .setTimeout(180)
    .build();
  tx.sign(platformKp, recipient);
  return tx.toXDR();
}

const lowReserveError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_low_reserve"] });

describe("submitSponsoredTrustline", () => {
  it("submits a well-formed sandwich and returns the hash", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => ({ hash: "SPONSOR_HASH" })) }) as never,
    );
    const { hash } = await submitSponsoredTrustline(sandwichXdr(recipient), recipient.publicKey());
    expect(hash).toBe("SPONSOR_HASH");
  });

  it("rejects a tampered envelope before submitting", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    await expect(submitSponsoredTrustline(tamperedXdr(recipient), recipient.publicKey())).rejects.toMatchObject({
      code: "invalid_sponsor_tx",
      retryable: false,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps op_low_reserve to a non-retryable error", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => { throw lowReserveError(); }) }) as never,
    );
    await expect(submitSponsoredTrustline(sandwichXdr(recipient), recipient.publicKey())).rejects.toMatchObject({
      code: "op_low_reserve",
      retryable: false,
    });
  });

  it("maps tx_bad_seq to a retryable error", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => { throw badSeqError(); }) }) as never,
    );
    await expect(submitSponsoredTrustline(sandwichXdr(recipient), recipient.publicKey())).rejects.toMatchObject({
      code: "tx_bad_seq",
      retryable: true,
    });
  });

  it("rejects a 4-op sandwich where createAccount.destination differs from sponsoredId", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    await expect(submitSponsoredTrustline(mismatchedCreateAccountXdr(recipient), recipient.publicKey())).rejects.toMatchObject({
      code: "invalid_sponsor_tx",
      retryable: false,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  // Fix 2: expectedRecipient that differs from envelope's sponsoredId → rejected.
  it("rejects when expectedRecipient differs from envelope sponsoredId", async () => {
    const recipient = Keypair.random();
    const wrongRecipient = Keypair.random().publicKey();
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    await expect(submitSponsoredTrustline(sandwichXdr(recipient), wrongRecipient)).rejects.toMatchObject({
      code: "invalid_sponsor_tx",
      retryable: false,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  // Fix 3: garbage XDR → invalid_sponsor_tx, submit never called.
  it("rejects a garbage XDR string with invalid_sponsor_tx before submitting", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    await expect(submitSponsoredTrustline("not-valid-xdr-at-all", recipient.publicKey())).rejects.toMatchObject({
      code: "invalid_sponsor_tx",
      retryable: false,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  // Fix 4: endSponsoringFutureReserves.source is a different key → rejected.
  it("rejects a sandwich where endSponsoringFutureReserves.source differs from sponsored", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    await expect(submitSponsoredTrustline(wrongEndSponsoringXdr(recipient), recipient.publicKey())).rejects.toMatchObject({
      code: "invalid_sponsor_tx",
      retryable: false,
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
