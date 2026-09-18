import { describe, it, expect, beforeEach, vi } from "vitest";
import { Account, Asset, Keypair, Operation, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

// Real throwaway keypairs — only the signing/address machinery is exercised; all
// network I/O is mocked at the `server()` boundary below. Never funded.
const platformKp = Keypair.random();
const destPub = Keypair.random().publicKey();
process.env.STELLAR_PLATFORM_SECRET = platformKp.secret();
// USDC is an issued asset: the client builds a real payment against this issuer.
process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

// Mock only `server()`; keep the real config helpers (passphrase, asset,
// conversions) so the sponsored-trustline path builds a genuine, signed
// transaction against a fake Horizon.
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn() };
});

import { server } from "../config";
import {
  getTxStatus,
  StellarPaymentError,
  buildSponsoredTrustlineTx,
  prepareSponsoredTrustline,
  submitSponsoredTrustline,
  SPONSOR_MAX_FEE_PER_OP_STROOPS,
} from "../client";

const mockedServer = vi.mocked(server);

/** Resolve after `ms`. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Horizon rejection carrying `result_codes`, in the shape the SDK rethrows. */
function horizonError(result_codes: { transaction?: string; operations?: string[] }) {
  return { response: { data: { extras: { result_codes } } } };
}
/** Horizon's stale-sequence rejection. */
const badSeqError = () => horizonError({ transaction: "tx_bad_seq" });
/** Horizon's rejection for a destination account that does not exist. */
const opNoDestError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_no_destination"] });
/** Horizon's rejection for a destination without the asset's trustline. */
const opNoTrustError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_no_trust"] });

type FakeServer = {
  loadAccount: ReturnType<typeof vi.fn>;
  fetchBaseFee: ReturnType<typeof vi.fn>;
  submitTransaction: ReturnType<typeof vi.fn>;
  transactions: () => { transaction: () => { call: () => Promise<unknown> } };
  ledgers: () => { order: () => { limit: () => { call: () => Promise<unknown> } } };
};

/** A Horizon account response: enough native XLM, no subentries, nothing sponsored. */
function horizonAccount(pub: string, xlm = "100.0000000") {
  return Object.assign(new Account(pub, "1000"), {
    balances: [{ asset_type: "native", balance: xlm, selling_liabilities: "0.0000000" }],
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
  });
}

/** A fake Horizon: funded accounts, a 100-stroop base fee, and a 0.5 XLM base reserve. */
function makeServer(opts: {
  submitTransaction?: ReturnType<typeof vi.fn>;
  call?: () => Promise<unknown>;
}): FakeServer {
  return {
    loadAccount: vi.fn(async (pub: string) => horizonAccount(pub)),
    fetchBaseFee: vi.fn(async () => 100),
    submitTransaction: opts.submitTransaction ?? vi.fn(async () => ({ hash: "HASH" })),
    transactions: () => ({
      transaction: () => ({ call: opts.call ?? (async () => ({ successful: true })) }),
    }),
    // Testnet and mainnet base reserve: 0.5 XLM.
    ledgers: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: [{ base_reserve_in_stroops: 5_000_000 }] }) }) }),
    }),
  };
}

beforeEach(() => {
  mockedServer.mockReset();
});

describe("single-key submit path (retired by #7)", () => {
  it("no longer exports payUsdc — every payout goes through the multisig submitter", async () => {
    const client = await import("../client");
    expect(client).not.toHaveProperty("payUsdc");
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

/** Horizon 404 shape (account not found). */
const notFound = () => ({ response: { status: 404 } });

describe("buildSponsoredTrustlineTx", () => {
  it("builds a begin/changeTrust/end sandwich for an existing account", async () => {
    const recipient = Keypair.random().publicKey();
    const srv = makeServer({});
    // platform load (seq) + recipient load (exists) both succeed.
    srv.loadAccount = vi.fn(async (pub: string) => horizonAccount(pub));
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
      return horizonAccount(pub);
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

/**
 * A valid trustline-only sandwich XDR for submit tests. Platform and recipient
 * both sign, so it passes the guard; Horizon is mocked, so it is never sent.
 */
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
/** The USDC asset for the issuer this suite configures. */
function makeUsdc() {
  return new Asset("USDC", process.env.STELLAR_USDC_ISSUER!);
}
/** A tampered envelope: an extra payment op the platform never sponsored. */
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
/**
 * A sandwich where endSponsoringFutureReserves.source is a DIFFERENT key than the
 * sponsored recipient. Fix 4 ensures this is rejected before submit.
 */
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
/**
 * A crafted 4-op sandwich where createAccount targets a DIFFERENT account than
 * the sponsoredId (and changeTrust.source). This must be rejected by
 * assertSponsoredTrustlineShape before submit.
 */
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

/** Horizon's rejection when the sponsor cannot fund the sponsored reserves. */
const lowReserveError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_low_reserve"] });

describe("submitSponsoredTrustline", () => {
  it("submits a well-formed sandwich and returns the envelope's own hash", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn(async () => ({ hash: "SPONSOR_HASH" }));
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    const xdr = sandwichXdr(recipient);
    const { hash } = await submitSponsoredTrustline(xdr, recipient.publicKey());
    // The hash the route recorded before broadcast — the same one Horizon names.
    expect(hash).toBe((TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction).hash().toString("hex"));
    expect(submit).toHaveBeenCalledTimes(1);
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

/**
 * #27 — the account-creation envelope a brand-new, zero-XLM contributor co-signs.
 * Each variant differs from what `buildSponsoredTrustlineTx` produces in exactly
 * one field, so a rejection names the field the guard exists for.
 */
function accountEnvelope(
  recipient: Keypair,
  o: {
    source?: string;
    baseFee?: string;
    timeoutSeconds?: number;
    startingBalance?: string;
    limit?: string;
    injectSetOptions?: boolean;
    signers?: Keypair[];
  } = {},
): string {
  const r = recipient.publicKey();
  const builder = new TransactionBuilder(new Account(o.source ?? platformKp.publicKey(), "1000"), {
    fee: o.baseFee ?? "100",
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: r }))
    .addOperation(Operation.createAccount({ destination: r, startingBalance: o.startingBalance ?? "0" }));
  if (o.injectSetOptions) {
    // A second signer on the contributor's new account: it would stop being theirs alone.
    builder.addOperation(
      Operation.setOptions({ source: r, signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 } }),
    );
  }
  const tx = builder
    .addOperation(Operation.changeTrust({ asset: makeUsdc(), source: r, ...(o.limit ? { limit: o.limit } : {}) }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: r }))
    .setTimeout(o.timeoutSeconds ?? 180)
    .build();
  tx.sign(...(o.signers ?? [platformKp, recipient]));
  return tx.toXDR();
}

describe("prepareSponsoredTrustline", () => {
  it("validates without touching Horizon, and exposes the hash and expiry before any broadcast", async () => {
    const recipient = Keypair.random();
    const submit = vi.fn(async () => ({ hash: "IGNORED" }));
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);
    const xdr = accountEnvelope(recipient);
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;

    const prepared = prepareSponsoredTrustline(xdr, recipient.publicKey());

    expect(prepared.hash).toBe(tx.hash().toString("hex"));
    expect(prepared.kind).toBe("account+trustline");
    expect(prepared.expiresAt.getTime()).toBe(Number(tx.timeBounds!.maxTime) * 1000);
    expect(submit).not.toHaveBeenCalled();

    expect(await prepared.submit()).toEqual({ hash: prepared.hash, feeBumpHash: expect.any(String) });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("accepts the envelope the builder produces once the contributor signs it", async () => {
    const recipient = Keypair.random();
    const srv = makeServer({});
    srv.loadAccount = vi.fn(async (pub: string) => {
      if (pub === recipient.publicKey()) throw notFound();
      return horizonAccount(pub);
    });
    mockedServer.mockReturnValue(srv as never);

    const { xdr } = await buildSponsoredTrustlineTx(recipient.publicKey());
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;
    tx.sign(recipient);

    expect(prepareSponsoredTrustline(tx.toXDR(), recipient.publicKey()).kind).toBe("account+trustline");
  });

  /** Assert `prepareSponsoredTrustline` refuses `signedXdr` as `invalid_sponsor_tx`. */
  const rejects = (signedXdr: string, recipient: Keypair) =>
    expect(() => prepareSponsoredTrustline(signedXdr, recipient.publicKey())).toThrow(
      expect.objectContaining({ code: "invalid_sponsor_tx", retryable: false }),
    );

  it("rejects a createAccount that would fund the account with XLM", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { startingBalance: "1" }), recipient);
  });

  it("rejects a negative starting balance as an invalid envelope, not a server error", () => {
    const recipient = Keypair.random();
    // The SDK refuses to build this, but the XDR can carry it and decodes as "-1.0000000".
    const envelope = (TransactionBuilder.fromXDR(accountEnvelope(recipient), networkPassphrase()) as Transaction).toEnvelope();
    envelope.v1().tx().operations()[1].body().createAccountOp().startingBalance(xdr.Int64.fromString("-10000000"));
    envelope.v1().signatures([]);
    const tampered = new Transaction(envelope, networkPassphrase());
    tampered.sign(platformKp, recipient);

    rejects(tampered.toXDR(), recipient);
  });

  it("rejects an envelope sourced by the contributor, who would then pay the fee", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { source: recipient.publicKey() }), recipient);
  });

  it("rejects a fee above the per-operation bound", () => {
    const recipient = Keypair.random();
    rejects(
      accountEnvelope(recipient, { baseFee: String(SPONSOR_MAX_FEE_PER_OP_STROOPS + 1) }),
      recipient,
    );
  });

  it("rejects an envelope with no upper time bound", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { timeoutSeconds: 0 }), recipient);
  });

  it("rejects an envelope valid for longer than the builder ever issues", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { timeoutSeconds: 3600 }), recipient);
  });

  it("rejects a trustline with a non-default limit", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { limit: "10" }), recipient);
  });

  it("rejects an injected setOptions — no second signer can ride along", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { injectSetOptions: true }), recipient);
  });

  it("rejects an envelope the sponsor never signed", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { signers: [recipient] }), recipient);
  });

  it("rejects an envelope signed by some other key in the sponsor's place", () => {
    const recipient = Keypair.random();
    rejects(accountEnvelope(recipient, { signers: [Keypair.random(), recipient] }), recipient);
  });
});

describe("submitSponsoredTrustline — telling an ambiguous submit from a definite one", () => {
  /** Submit a valid envelope to a Horizon that throws `error`. */
  const submitWith = async (error: unknown) => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(
      makeServer({ submitTransaction: vi.fn(async () => { throw error; }) }) as never,
    );
    return submitSponsoredTrustline(accountEnvelope(recipient), recipient.publicKey());
  };

  it("classifies a Horizon 504 timeout as submission_unknown — the envelope may still land", async () => {
    await expect(submitWith({ response: { status: 504, data: { title: "Timeout" } } })).rejects.toMatchObject({
      code: "submission_unknown",
    });
  });

  it("classifies a Horizon 5xx without result codes as submission_unknown", async () => {
    await expect(submitWith({ response: { status: 503, data: {} } })).rejects.toMatchObject({
      code: "submission_unknown",
    });
  });

  it("classifies a network failure with no response as submission_unknown", async () => {
    await expect(submitWith(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).rejects.toMatchObject({
      code: "submission_unknown",
    });
  });

  it("classifies other result codes as a definite sponsor_tx_rejected", async () => {
    await expect(
      submitWith({ response: { status: 400, data: { extras: { result_codes: { transaction: "tx_bad_auth" } } } } }),
    ).rejects.toMatchObject({ code: "sponsor_tx_rejected", retryable: false });
  });

  it("classifies a 4xx without result codes as a definite sponsor_tx_rejected", async () => {
    await expect(submitWith({ response: { status: 400, data: {} } })).rejects.toMatchObject({
      code: "sponsor_tx_rejected",
    });
  });
});

describe("buildSponsoredTrustlineTx — sponsor reserve pre-check", () => {
  /** A fake Horizon whose sponsor holds `xlm`, and where `recipient` exists or 404s. */
  const serverWithSponsorXlm = (recipient: string, xlm: string, exists: boolean) => {
    const srv = makeServer({});
    srv.loadAccount = vi.fn(async (pub: string) => {
      if (pub === recipient) {
        if (!exists) throw notFound();
        return horizonAccount(pub);
      }
      return horizonAccount(pub, xlm);
    });
    return srv;
  };

  // The sponsor's own two base reserves (1 XLM) are locked; what remains must
  // cover the reserves this sponsorship adds plus the fee.
  it("refuses to offer an account-creation XDR the sponsor cannot cover (3 reserves + fee)", async () => {
    const recipient = Keypair.random().publicKey();
    mockedServer.mockReturnValue(serverWithSponsorXlm(recipient, "2.5000000", false) as never);
    await expect(buildSponsoredTrustlineTx(recipient)).rejects.toMatchObject({
      code: "sponsor_low_reserve",
      retryable: false,
    });
  });

  it("offers it once the sponsor can cover the reserves and the fee", async () => {
    const recipient = Keypair.random().publicKey();
    mockedServer.mockReturnValue(serverWithSponsorXlm(recipient, "2.5100000", false) as never);
    await expect(buildSponsoredTrustlineTx(recipient)).resolves.toMatchObject({ kind: "account+trustline" });
  });

  it("needs only one reserve for a trustline on an existing account", async () => {
    const recipient = Keypair.random().publicKey();
    mockedServer.mockReturnValue(serverWithSponsorXlm(recipient, "1.4000000", true) as never);
    await expect(buildSponsoredTrustlineTx(recipient)).rejects.toMatchObject({ code: "sponsor_low_reserve" });

    mockedServer.mockReturnValue(serverWithSponsorXlm(recipient, "1.6000000", true) as never);
    await expect(buildSponsoredTrustlineTx(recipient)).resolves.toMatchObject({ kind: "trustline" });
  });

  it("keeps a surging network fee out of the envelope the contributor signs (#28)", async () => {
    const recipient = Keypair.random().publicKey();
    const srv = serverWithSponsorXlm(recipient, "100.0000000", false);
    srv.fetchBaseFee = vi.fn(async () => SPONSOR_MAX_FEE_PER_OP_STROOPS * 50);
    mockedServer.mockReturnValue(srv as never);

    const { xdr } = await buildSponsoredTrustlineTx(recipient);
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;
    // The fee bump makes the bid at submit, clamped there; see sponsor-fee-bump.test.ts.
    expect(Number(tx.fee)).toBe(100 * tx.operations.length);
  });
});
