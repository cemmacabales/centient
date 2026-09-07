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

import { server } from "../config";
import { StellarPaymentError } from "../client";
import type { PayoutCoSignRequest, PayoutCoSigner } from "../payout-envelope";
import {
  parsePayoutSignerConfig,
  submitMultisigPayout,
  type PayoutSignerConfig,
} from "../payout-submitter";

const mockedServer = vi.mocked(server);
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

function horizonError(result_codes: { transaction?: string; operations?: string[] }) {
  return { response: { data: { extras: { result_codes } } } };
}

/** A fake Horizon whose sequence only advances on a successful submit. */
function makeHorizon(opts: { submitTransaction?: ReturnType<typeof vi.fn> } = {}) {
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
    },
  };
}

function request(submissionId: string, amountUnits = 25_000_000n) {
  return { submissionId, destination: Keypair.random().publicKey(), amountUnits };
}

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
  mockedServer.mockReset();
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

  it("rejects a non-positive amount before contacting Horizon", async () => {
    const horizon = makeHorizon();
    mockedServer.mockReturnValue(horizon.server as never);

    await expect(
      submitMultisigPayout(request("s1", 0n), { coSigner: honestCoSigner(), config }),
    ).rejects.toThrow(/must be positive/i);
    expect(horizon.server.loadAccount).not.toHaveBeenCalled();
  });
});
