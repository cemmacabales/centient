import { describe, it, expect, beforeEach, vi } from "vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";

// Real throwaway keypairs — only the signing/address machinery is exercised; all
// network I/O is mocked at the `server()` boundary below. Never funded.
const platformKp = Keypair.random();
const destPub = Keypair.random().publicKey();
process.env.STELLAR_PLATFORM_SECRET = platformKp.secret();

// Mock only `server()`; keep the real config helpers (passphrase, conversions)
// so payXlm builds a genuine, signed transaction against a fake Horizon.
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn() };
});

import { server } from "../config";
import { payXlm, getTxStatus, StellarPaymentError } from "../client";

const mockedServer = vi.mocked(server);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function horizonError(result_codes: { transaction?: string; operations?: string[] }) {
  return { response: { data: { extras: { result_codes } } } };
}
const badSeqError = () => horizonError({ transaction: "tx_bad_seq" });
const opNoDestError = () =>
  horizonError({ transaction: "tx_failed", operations: ["op_no_destination"] });

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

describe("payXlm", () => {
  it("builds, signs, submits and returns the tx hash on success", async () => {
    const submit = vi.fn(async () => ({ hash: "HASH_OK" }));
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    const res = await payXlm(destPub, 15_000_000n);

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

    const res = await payXlm(destPub, 1n);

    expect(res.hash).toBe("HASH_RETRY");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(srv.loadAccount).toHaveBeenCalledTimes(2); // fresh sequence on retry
  });

  it("propagates a second consecutive tx_bad_seq (no infinite retry)", async () => {
    const submit = vi.fn().mockRejectedValue(badSeqError());
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await expect(payXlm(destPub, 1n)).rejects.toMatchObject(
      horizonError({ transaction: "tx_bad_seq" }),
    );
    expect(submit).toHaveBeenCalledTimes(2); // initial + one retry, then give up
  });

  it("throws a non-retryable StellarPaymentError on op_no_destination and never retries", async () => {
    const submit = vi.fn().mockRejectedValue(opNoDestError());
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await expect(payXlm(destPub, 1n)).rejects.toMatchObject({
      name: "StellarPaymentError",
      code: "op_no_destination",
      retryable: false,
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive amount without touching the network", async () => {
    const submit = vi.fn();
    mockedServer.mockReturnValue(makeServer({ submitTransaction: submit }) as never);

    await expect(payXlm(destPub, 0n)).rejects.toBeInstanceOf(StellarPaymentError);
    await expect(payXlm(destPub, -5n)).rejects.toBeInstanceOf(StellarPaymentError);
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

    await Promise.all(Array.from({ length: 8 }, () => payXlm(destPub, 1n)));

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
