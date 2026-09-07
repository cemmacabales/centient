import { Account, Asset, FeeBumpTransaction, Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platformSigner = Keypair.random();
const coSignerKp = Keypair.random();
const strangerKp = Keypair.random();
const payoutAccount = Keypair.random().publicKey();
const usdc = new Asset("USDC", Keypair.random().publicKey());

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn(), usdcAsset: () => usdc };
});

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return { ...actual, getTxStatus: vi.fn() };
});

import { server } from "../config";
import { StellarPaymentError, getTxStatus } from "../client";
import type { PayoutCoSignRequest, PayoutCoSigner } from "../payout-envelope";
import {
  parsePayoutSignerConfig,
  submitMultisigPayout,
  type PayoutSignerConfig,
} from "../payout-submitter";

const mockedServer = vi.mocked(server);
const mockedGetTxStatus = vi.mocked(getTxStatus);
/** Resolve after `ms`, used to make the fake Horizon slow enough to interleave. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config: PayoutSignerConfig = {
  payoutAccount,
  platformSigner,
  coSignerPublicKey: coSignerKp.publicKey(),
};

/** A co-signer that signs whatever it is asked to, like #8's happy path. */
function honestCoSigner(signer = coSignerKp): PayoutCoSigner {
  return {
    signPayout: vi.fn(async (request: PayoutCoSignRequest) => {
      const { TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
      const tx = TransactionBuilder.fromXDR(request.xdr, Networks.TESTNET);
      return {
        publicKey: signer.publicKey(),
        signature: signer.sign(tx.hash()).toString("base64"),
      };
    }),
  };
}

/** A Horizon rejection carrying result codes — a definite verdict, not an ambiguous one. */
function horizonError(result_codes: { transaction?: string; operations?: string[] }) {
  return { response: { data: { extras: { result_codes } } } };
}

/** A fake Horizon whose sequence only advances on a successful submit. */
function makeHorizon(
  opts: {
    submitTransaction?: ReturnType<typeof vi.fn>;
    /** Close time of the newest ingested ledger — the clock that retires an
     *  envelope. `null` makes the lookup fail, as an unreachable Horizon does. */
    ledgerCloseAt?: () => Date | null;
  } = {},
) {
  const submitted: FeeBumpTransaction[] = [];
  let sequence = 100n;
  const submitTransaction =
    opts.submitTransaction ??
    vi.fn(async (tx: FeeBumpTransaction) => {
      await delay(1);
      submitted.push(tx);
      sequence += 1n;
      return { hash: `HASH_${submitted.length}` };
    });
  return {
    submitted,
    currentSequence: () => sequence,
    server: {
      // The artificial delay is what makes an unsynchronized implementation
      // interleave: two loads would observe the same sequence before either submits.
      loadAccount: vi.fn(async (pub: string) => {
        await delay(1);
        return new Account(pub, sequence.toString());
      }),
      fetchBaseFee: vi.fn(async () => 100),
      submitTransaction,
      ledgers: vi.fn(() => ({
        order: () => ({
          limit: () => ({
            call: async () => {
              const closedAt = (opts.ledgerCloseAt ?? (() => new Date()))();
              if (closedAt === null) throw new Error("503 Service Unavailable");
              return { records: [{ closed_at: closedAt.toISOString() }] };
            },
          }),
        }),
      })),
    },
  };
}

/** One payout request against a fresh destination. */
function request(submissionId: string, amountUnits = 25_000_000n) {
  return {
    reference: { kind: "submission" as const, id: submissionId },
    destination: Keypair.random().publicKey(),
    amountUnits,
  };
}

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
  mockedServer.mockReset();
  mockedGetTxStatus.mockReset();
});

describe("parsePayoutSignerConfig", () => {
  const env = {
    STELLAR_PLATFORM_ACCOUNT: payoutAccount,
    STELLAR_OPS_SIGNER_SECRET: platformSigner.secret(),
    STELLAR_POLICY_SIGNER_PUBLIC: coSignerKp.publicKey(),
  };

  it("reads the payout account and both signer identities", () => {
    const parsed = parsePayoutSignerConfig(env);
    expect(parsed.payoutAccount).toBe(payoutAccount);
    expect(parsed.platformSigner.publicKey()).toBe(platformSigner.publicKey());
    expect(parsed.coSignerPublicKey).toBe(coSignerKp.publicKey());
  });

  it("rejects a missing co-signer key rather than defaulting", () => {
    expect(() =>
      parsePayoutSignerConfig({ ...env, STELLAR_POLICY_SIGNER_PUBLIC: undefined }),
    ).toThrow(/STELLAR_POLICY_SIGNER_PUBLIC/);
  });

  it("rejects a malformed payout account", () => {
    expect(() =>
      parsePayoutSignerConfig({ ...env, STELLAR_PLATFORM_ACCOUNT: "nope" }),
    ).toThrow(/valid Stellar public key/i);
  });

  it("rejects a co-signer that is the platform signer, which is not two parties", () => {
    expect(() =>
      parsePayoutSignerConfig({
        ...env,
        STELLAR_POLICY_SIGNER_PUBLIC: platformSigner.publicKey(),
      }),
    ).toThrow(/must be independent/i);
  });
});

describe("submitMultisigPayout", () => {
  it("submits a fee-bumped, dual-signed payout and returns the hash", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    const result = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    });

    expect(result.hash).toBe("HASH_1");
    expect(horizon.submitted).toHaveLength(1);
  });

  it("pays the XLM fee from the payout account so the recipient spends none", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    await submitMultisigPayout(request("s1"), { coSigner: honestCoSigner(), config });

    const feeBump = horizon.submitted[0];
    expect(feeBump).toBeInstanceOf(FeeBumpTransaction);
    expect(feeBump.feeSource).toBe(payoutAccount);
  });

  it("submits an inner payment carrying two distinct valid signatures", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    await submitMultisigPayout(request("s1"), { coSigner: honestCoSigner(), config });

    const inner = horizon.submitted[0].innerTransaction;
    const hash = inner.hash();
    expect(inner.signatures).toHaveLength(2);
    expect(inner.signatures.some((s) => platformSigner.verify(hash, s.signature()))).toBe(true);
    expect(inner.signatures.some((s) => coSignerKp.verify(hash, s.signature()))).toBe(true);
  });

  it("carries the exact stroop amount into the submitted payment", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    await submitMultisigPayout(request("s1", 1n), { coSigner: honestCoSigner(), config });

    const op = horizon.submitted[0].innerTransaction.operations[0] as { amount: string };
    expect(op.amount).toBe("0.0000001");
  });

  it("submits nothing when the co-signer refuses", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);
    const refusing: PayoutCoSigner = {
      signPayout: vi.fn(async () => {
        throw new Error("policy service declined this payout");
      }),
    };

    await expect(
      submitMultisigPayout(request("s1"), { coSigner: refusing, config }),
    ).rejects.toThrow(/declined/i);
    expect(horizon.server.submitTransaction).not.toHaveBeenCalled();
  });

  it("submits nothing when the co-signer returns another key's signature", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    await expect(
      submitMultisigPayout(request("s1"), {
        coSigner: honestCoSigner(strangerKp),
        config,
      }),
    ).rejects.toThrow(/not the configured co-signer/i);
    expect(horizon.server.submitTransaction).not.toHaveBeenCalled();
  });

  it("issues concurrent payouts with zero sequence collisions and zero double-pays", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);
    const requests = Array.from({ length: 12 }, (_, i) => request(`s${i}`));

    const results = await Promise.all(
      requests.map((r) => submitMultisigPayout(r, { coSigner: honestCoSigner(), config })),
    );

    expect(results).toHaveLength(12);
    expect(horizon.submitted).toHaveLength(12);

    const sequences = horizon.submitted.map((tx) => tx.innerTransaction.sequence);
    expect(new Set(sequences).size).toBe(12);

    const destinations = horizon.submitted.map(
      (tx) => (tx.innerTransaction.operations[0] as { destination: string }).destination,
    );
    expect(new Set(destinations).size).toBe(12);
    expect(new Set(destinations)).toEqual(new Set(requests.map((r) => r.destination)));
  });

  it("maps op_no_trust to a non-retryable failure", async () => {
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw horizonError({ transaction: "tx_failed", operations: ["op_no_trust"] });
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("op_no_trust");
    expect(err.retryable).toBe(false);
  });

  it("maps op_no_destination to a non-retryable failure", async () => {
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw horizonError({ transaction: "tx_failed", operations: ["op_no_destination"] });
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("op_no_destination");
    expect(err.retryable).toBe(false);
  });

  it("rebuilds and resubmits once on a stale sequence", async () => {
    let attempts = 0;
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw horizonError({ transaction: "tx_bad_seq" });
        return { hash: "HASH_RETRY" };
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);

    const result = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    });

    expect(result.hash).toBe("HASH_RETRY");
    expect(attempts).toBe(2);
  });

  it("re-signs the rebuilt envelope rather than reusing the stale signatures", async () => {
    const coSigner = honestCoSigner();
    let attempts = 0;
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw horizonError({ transaction: "tx_bad_seq" });
        return { hash: "HASH_RETRY" };
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);

    await submitMultisigPayout(request("s1"), { coSigner, config });

    // A rebuilt envelope has a new hash, so both stages must be co-signed again:
    // 2 stages x 2 attempts.
    expect(coSigner.signPayout).toHaveBeenCalledTimes(4);
  });

  it("classifies sustained sequence contention as retryable", async () => {
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw horizonError({ transaction: "tx_bad_seq" });
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("tx_bad_seq");
    expect(err.retryable).toBe(true);
  });

  it("does not rebuild when the submit outcome is ambiguous", async () => {
    // A timeout carries no Horizon result codes, so the transaction may well have
    // been accepted. Rebuilding here is what double-pays.
    const submitted: FeeBumpTransaction[] = [];
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async (tx: FeeBumpTransaction) => {
        submitted.push(tx);
        throw new Error("socket hang up");
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus.mockResolvedValue("confirmed");
    const coSigner = honestCoSigner();

    const result = await submitMultisigPayout(request("s1"), { coSigner, config });

    expect(horizon.server.submitTransaction).toHaveBeenCalledTimes(1);
    // Two stages, one attempt — a rebuild would have made it four.
    expect(coSigner.signPayout).toHaveBeenCalledTimes(2);
    expect(result.hash).toBe(submitted[0].hash().toString("hex"));
  });

  it("resolves an ambiguous submit that actually settled by its envelope hash", async () => {
    const submitted: FeeBumpTransaction[] = [];
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async (tx: FeeBumpTransaction) => {
        submitted.push(tx);
        throw new Error("504 Gateway Timeout");
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus.mockResolvedValue("confirmed");

    const result = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    });

    expect(mockedGetTxStatus).toHaveBeenCalledWith(submitted[0].hash().toString("hex"));
    expect(result.hash).toBe(submitted[0].hash().toString("hex"));
  });

  it("treats an ambiguous submit Horizon reports as failed as non-retryable", async () => {
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus.mockResolvedValue("failed");

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.retryable).toBe(false);
  });

  it("withholds retry until the envelope can no longer be included", async () => {
    // While the envelope is still inside its time bounds, an absent transaction
    // may yet be included, so a retry would risk a second settlement. The ledger
    // clock starts behind maxTime and crosses it, which is what licenses retry.
    const started = Date.now();
    let ledgerReads = 0;
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
      // Two ledgers close inside the envelope's one-second bounds, then one
      // closes well past them.
      ledgerCloseAt: () =>
        new Date(ledgerReads++ < 2 ? started : started + 10_000),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus.mockResolvedValue("not_found");

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
      timeoutSeconds: 1,
      ambiguousPollIntervalMs: 10,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("ambiguous_submit");
    // Only safe to requeue because the envelope's time bounds have expired.
    expect(err.retryable).toBe(true);
    expect(mockedGetTxStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("re-reads the envelope after the expiry ledger rather than trusting a stale absence", async () => {
    // The race the ordering exists to close: the transaction is absent when first
    // asked, then gets included *inside* its bounds, and only afterwards does a
    // ledger close past maxTime. Pairing that stale absence with the later ledger
    // would declare a settled payout dead and license a rebuild that pays twice.
    const submitted: FeeBumpTransaction[] = [];
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async (tx: FeeBumpTransaction) => {
        submitted.push(tx);
        throw new Error("socket hang up");
      }),
      ledgerCloseAt: () => new Date(Date.now() + 10_000),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus
      .mockResolvedValueOnce("not_found")
      .mockResolvedValue("confirmed");

    const result = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
      timeoutSeconds: 1,
      ambiguousPollIntervalMs: 10,
    });

    // Resolved to the settled transaction, never rebuilt.
    expect(result.hash).toBe(submitted[0].hash().toString("hex"));
    expect(horizon.server.submitTransaction).toHaveBeenCalledTimes(1);
    expect(mockedGetTxStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("judges expiry by ledger close time, not by a host clock running ahead", async () => {
    // Stellar evaluates maxTime against ledger close time. A host clock ahead of
    // the network must not retire an envelope the network would still include —
    // that is the rebuild that settles twice. Here the ledger stays pinned before
    // maxTime while wall clock sails past it.
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
      ledgerCloseAt: () => new Date(Date.now() - 3_600_000),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus.mockResolvedValue("not_found");

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
      timeoutSeconds: 1,
      ambiguousPollIntervalMs: 10,
      ambiguousResolveGraceMs: 50,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("ambiguous_submit");
    // Never proven dead, so a human reconciles rather than the worker rebuilding.
    expect(err.retryable).toBe(false);
  });

  it("keeps polling the same envelope when the status lookup itself fails", async () => {
    // A failed lookup is not evidence of absence. Letting it escape would send the
    // worker down the requeue-and-rebuild path, double-paying a settled payout.
    const submitted: FeeBumpTransaction[] = [];
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async (tx: FeeBumpTransaction) => {
        submitted.push(tx);
        throw new Error("socket hang up");
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue("confirmed");

    const result = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
      ambiguousPollIntervalMs: 10,
    });

    const envelopeHash = submitted[0].hash().toString("hex");
    expect(result.hash).toBe(envelopeHash);
    // Every lookup asked about the same envelope; none of them rebuilt it.
    expect(mockedGetTxStatus.mock.calls).toEqual([
      [envelopeHash],
      [envelopeHash],
      [envelopeHash],
    ]);
    expect(horizon.server.submitTransaction).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(1);
  });

  it("hands over for reconciliation when Horizon never answers", async () => {
    // Horizon down for the whole resolve window: the payout's fate is unknown, so
    // it must not be requeued and must not be refunded.
    const horizon = makeHorizon({
      submitTransaction: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    mockedServer.mockReturnValue(horizon.server as never);
    mockedGetTxStatus.mockRejectedValue(new Error("503 Service Unavailable"));

    const err = await submitMultisigPayout(request("s1"), {
      coSigner: honestCoSigner(),
      config,
      timeoutSeconds: 1,
      ambiguousPollIntervalMs: 10,
      ambiguousResolveGraceMs: 50,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("ambiguous_submit");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/reconcile manually/i);
  });

  it("rejects a non-positive amount before contacting Horizon", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    await expect(
      submitMultisigPayout(request("s1", 0n), { coSigner: honestCoSigner(), config }),
    ).rejects.toThrow(/must be positive/i);
    expect(horizon.server.loadAccount).not.toHaveBeenCalled();
  });
});
