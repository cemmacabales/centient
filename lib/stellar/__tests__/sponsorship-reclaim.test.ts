import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

// #29 — the chain side of sponsored-reserve reclaim. Real throwaway keypairs and
// real envelopes; only Horizon is faked, at the `server()` boundary. Never funded.
const sponsorKp = Keypair.random();
const ownerPub = Keypair.random().publicKey();
process.env.STELLAR_SPONSOR_SECRET = sponsorKp.secret();
process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();
delete process.env.STELLAR_PLATFORM_SECRET;
delete process.env.STELLAR_NETWORK;

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn() };
});

import { server, usdcAsset } from "../config";
import {
  assertRevocationShape,
  canonicalEntries,
  classifyRevocationError,
  loadBaseReserveStroops,
  prepareRevocation,
  readChainSponsorship,
  readRevokedEntries,
  readSponsorshipOnChain,
  reserveUnitsOf,
  type SponsoredEntry,
} from "../sponsorship-reclaim";
import { StellarPaymentError } from "../client";

const mockedServer = vi.mocked(server);
const HALF_XLM = 5_000_000n;

/** A Horizon rejection carrying `result_codes`, in the shape the SDK rethrows. */
function horizonError(result_codes: { transaction?: string; operations?: string[] }, status = 400) {
  return { response: { status, data: { extras: { result_codes } } } };
}

/** Build and sign a transaction from `ops`, with every field a negative case may bend. */
function envelope(opts: {
  ops: xdr.Operation[];
  source?: string;
  signers?: Keypair[];
  passphrase?: string;
  fee?: string;
  timeout?: number;
  memo?: Memo;
}): Transaction {
  const builder = new TransactionBuilder(new Account(opts.source ?? sponsorKp.publicKey(), "41"), {
    fee: opts.fee ?? "100",
    networkPassphrase: opts.passphrase ?? Networks.TESTNET,
    memo: opts.memo,
  });
  opts.ops.forEach((op) => builder.addOperation(op));
  const tx = builder.setTimeout(opts.timeout ?? 180).build();
  (opts.signers ?? [sponsorKp]).forEach((kp) => tx.sign(kp));
  return tx;
}

const revokeTrustline = (account = ownerPub, asset: Asset = usdcAsset()) =>
  Operation.revokeTrustlineSponsorship({ account, asset });
const revokeAccount = (account = ownerPub) => Operation.revokeAccountSponsorship({ account });
/** The shape every negative case is checked against: both entries of `ownerPub`. */
const both = { sponsor: sponsorKp, address: ownerPub, entries: ["trustline", "account"] as SponsoredEntry[] };

/** Expect `fn` to throw `invalid_reclaim_tx` with a message matching `why`. */
function expectRefused(fn: () => void, why: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StellarPaymentError);
    expect((err as StellarPaymentError).code).toBe("invalid_reclaim_tx");
    expect((err as Error).message).toMatch(why);
    return;
  }
  throw new Error("expected invalid_reclaim_tx");
}

/** A Horizon account response for the owner, with whatever sponsorship state a case needs. */
function ownerAccount(opts: {
  accountSponsor?: string;
  trustlineSponsor?: string | null;
  usdcBalance?: string;
  xlm?: string;
  extraLines?: Array<Record<string, string>>;
  subentries?: number;
  numSponsored?: number;
}) {
  const asset = usdcAsset();
  const balances: Array<Record<string, string>> = [];
  if (opts.trustlineSponsor !== null) {
    const trustline: Record<string, string> = {
      asset_type: "credit_alphanum4",
      asset_code: asset.getCode(),
      asset_issuer: asset.getIssuer()!,
      balance: opts.usdcBalance ?? "0.0000000",
      buying_liabilities: "0.0000000",
    };
    if (opts.trustlineSponsor) trustline.sponsor = opts.trustlineSponsor;
    balances.push(trustline);
  }
  balances.push(...(opts.extraLines ?? []));
  balances.push({ asset_type: "native", balance: opts.xlm ?? "0.0000000", selling_liabilities: "0.0000000" });
  return Object.assign(new Account(ownerPub, "7"), {
    balances,
    subentry_count: opts.subentries ?? (opts.trustlineSponsor === null ? 0 : 1),
    num_sponsoring: 0,
    num_sponsored: opts.numSponsored ?? 0,
    ...(opts.accountSponsor ? { sponsor: opts.accountSponsor } : {}),
  });
}

/** A fake Horizon: the sponsor at sequence 41, a 100-stroop fee, a 0.5 XLM base reserve. */
function fakeHorizon(opts: {
  owner?: unknown;
  ownerError?: unknown;
  submitTransaction?: ReturnType<typeof vi.fn>;
  baseReserve?: unknown;
} = {}) {
  return {
    loadAccount: vi.fn(async (pub: string) => {
      if (pub === sponsorKp.publicKey()) return new Account(pub, "41");
      if (opts.ownerError) throw opts.ownerError;
      return opts.owner;
    }),
    fetchBaseFee: vi.fn(async () => 100),
    submitTransaction: opts.submitTransaction ?? vi.fn(async () => ({ hash: "HASH" })),
    ledgers: () => ({
      order: () => ({
        limit: () => ({ call: async () => ({ records: [{ base_reserve_in_stroops: opts.baseReserve ?? 5_000_000 }] }) }),
      }),
    }),
  };
}

beforeEach(() => {
  mockedServer.mockReset();
});

describe("reserve units and entry order", () => {
  it("counts a trustline as one base reserve and an account as two", () => {
    expect(reserveUnitsOf(["trustline"])).toBe(1);
    expect(reserveUnitsOf(["account"])).toBe(2);
    expect(reserveUnitsOf(["account", "trustline"])).toBe(3);
  });

  it("puts entries in trustline-then-account order", () => {
    expect(canonicalEntries(["account", "trustline"])).toEqual(["trustline", "account"]);
    expect(canonicalEntries(["account"])).toEqual(["account"]);
  });

  it("refuses no entries, or an entry named twice", () => {
    expectRefused(() => canonicalEntries([]), /once each/);
    expectRefused(() => canonicalEntries(["trustline", "trustline"]), /once each/);
  });
});

describe("prepareRevocation", () => {
  it("builds exactly the sponsor's revocation of the owner's entries, signed once", async () => {
    const horizon = fakeHorizon();
    const prepared = await prepareRevocation(ownerPub, ["account", "trustline"], {
      srv: horizon as never,
      nowMs: Date.now(),
    });
    expect(prepared.entries).toEqual(["trustline", "account"]);

    const [[sent]] = await prepared.submit().then(() => horizon.submitTransaction.mock.calls);
    const tx = sent as Transaction;
    expect(tx.source).toBe(sponsorKp.publicKey());
    expect(tx.sequence).toBe("42");
    expect(tx.operations.map((op) => op.type)).toEqual(["revokeTrustlineSponsorship", "revokeAccountSponsorship"]);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.hash().toString("hex")).toBe(prepared.hash);
    expect(prepared.expiresAt.getTime()).toBe(Number(tx.timeBounds!.maxTime) * 1000);
  });

  it("revokes only the entries it is asked to", async () => {
    const horizon = fakeHorizon();
    const prepared = await prepareRevocation(ownerPub, ["account"], { srv: horizon as never });
    await prepared.submit();
    const tx = horizon.submitTransaction.mock.calls[0][0] as Transaction;
    expect(tx.operations.map((op) => op.type)).toEqual(["revokeAccountSponsorship"]);
  });

  it("answers revoked when Horizon accepts it", async () => {
    const prepared = await prepareRevocation(ownerPub, ["trustline"], { srv: fakeHorizon() as never });
    await expect(prepared.submit()).resolves.toEqual({ outcome: "revoked" });
  });

  it("answers a Horizon refusal as an outcome instead of throwing", async () => {
    const submitTransaction = vi.fn(async () => {
      throw horizonError({ transaction: "tx_failed", operations: ["op_low_reserve"] });
    });
    const prepared = await prepareRevocation(ownerPub, ["trustline"], {
      srv: fakeHorizon({ submitTransaction }) as never,
    });
    await expect(prepared.submit()).resolves.toEqual({ outcome: "owner_low_reserve" });
  });

  it("does not touch Horizon to submit before submit() is called", async () => {
    const horizon = fakeHorizon();
    await prepareRevocation(ownerPub, ["trustline", "account"], { srv: horizon as never });
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
  });
});

describe("assertRevocationShape", () => {
  const ok = () => envelope({ ops: [revokeTrustline(), revokeAccount()] });

  it("accepts the sponsor's revocation of both entries", () => {
    expect(() => assertRevocationShape(ok(), { ...both, nowMs: Date.now() })).not.toThrow();
  });

  it("refuses a revocation of a different address", () => {
    const other = Keypair.random().publicKey();
    const tx = envelope({ ops: [revokeTrustline(other), revokeAccount(other)] });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /targets/);
  });

  it("refuses one operation aimed at a different address beside a correct one", () => {
    const tx = envelope({ ops: [revokeTrustline(), revokeAccount(Keypair.random().publicKey())] });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /targets/);
  });

  it("refuses a trustline revocation for an asset other than the configured USDC", () => {
    const wrongIssuer = new Asset("USDC", Keypair.random().publicKey());
    const tx = envelope({ ops: [revokeTrustline(ownerPub, wrongIssuer), revokeAccount()] });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /asset other than/);
  });

  it("refuses a payment riding along", () => {
    const tx = envelope({
      ops: [
        revokeTrustline(),
        revokeAccount(),
        Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }),
      ],
    });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /unexpected op shape/);
  });

  it("refuses the entries in the other order, or entries it was not asked to revoke", () => {
    const swapped = envelope({ ops: [revokeAccount(), revokeTrustline()] });
    expectRefused(() => assertRevocationShape(swapped, { ...both, nowMs: Date.now() }), /unexpected op shape/);
    expectRefused(
      () => assertRevocationShape(ok(), { ...both, entries: ["trustline"], nowMs: Date.now() }),
      /unexpected op shape/,
    );
  });

  it("refuses an operation with its own source account", () => {
    const tx = envelope({
      ops: [Operation.revokeAccountSponsorship({ account: ownerPub, source: ownerPub })],
    });
    expectRefused(
      () => assertRevocationShape(tx, { ...both, entries: ["account"], nowMs: Date.now() }),
      /own source account/,
    );
  });

  it("refuses a transaction whose source is not the sponsor", () => {
    const other = Keypair.random();
    const tx = envelope({ ops: [revokeTrustline(), revokeAccount()], source: other.publicKey(), signers: [other] });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /source is not the sponsor/);
  });

  it("refuses an envelope the sponsor did not sign", () => {
    const tx = envelope({ ops: [revokeTrustline(), revokeAccount()], signers: [Keypair.random()] });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /valid sponsor signature/);
  });

  it("refuses a sponsor signature made for the other network", () => {
    const signedForMainnet = envelope({ ops: [revokeTrustline(), revokeAccount()], passphrase: Networks.PUBLIC });
    const asTestnet = new Transaction(signedForMainnet.toEnvelope(), Networks.TESTNET);
    expectRefused(() => assertRevocationShape(asTestnet, { ...both, nowMs: Date.now() }), /for this network/);
    // Handed over as the mainnet Transaction it was built as: its own hash would verify.
    expectRefused(() => assertRevocationShape(signedForMainnet, { ...both, nowMs: Date.now() }), /for this network/);
  });

  it("refuses a second signature riding along", () => {
    const tx = envelope({ ops: [revokeTrustline(), revokeAccount()], signers: [sponsorKp, Keypair.random()] });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /2 signatures/);
  });

  it("refuses a memo", () => {
    const tx = envelope({ ops: [revokeTrustline(), revokeAccount()], memo: Memo.text("hi") });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /memo/);
  });

  it("refuses a fee above the sponsor's per-operation bound", () => {
    const tx = envelope({ ops: [revokeTrustline(), revokeAccount()], fee: "100001" });
    expectRefused(() => assertRevocationShape(tx, { ...both, nowMs: Date.now() }), /exceeds/);
  });

  it("refuses an envelope with no upper time bound, or one valid for too long", () => {
    const forever = envelope({ ops: [revokeTrustline(), revokeAccount()], timeout: 0 });
    expectRefused(() => assertRevocationShape(forever, { ...both, nowMs: Date.now() }), /no upper time bound/);
    const hour = envelope({ ops: [revokeTrustline(), revokeAccount()], timeout: 3600 });
    expectRefused(() => assertRevocationShape(hour, { ...both, nowMs: Date.now() }), /longer than/);
  });
});

describe("classifyRevocationError", () => {
  it("reads op_low_reserve anywhere in the operations as the owner unable to cover", () => {
    expect(classifyRevocationError(horizonError({ transaction: "tx_failed", operations: ["op_success", "op_low_reserve"] })))
      .toEqual({ outcome: "owner_low_reserve" });
  });

  it("reads op_not_sponsor and op_does_not_exist as already released", () => {
    expect(classifyRevocationError(horizonError({ transaction: "tx_failed", operations: ["op_not_sponsor"] })))
      .toEqual({ outcome: "not_sponsored", codes: ["op_not_sponsor"] });
    expect(
      classifyRevocationError(horizonError({ transaction: "tx_failed", operations: ["op_success", "op_does_not_exist"] })),
    ).toEqual({ outcome: "not_sponsored", codes: ["op_does_not_exist"] });
  });

  it("prefers low reserve when one entry is gone and the other cannot be covered", () => {
    expect(
      classifyRevocationError(horizonError({ transaction: "tx_failed", operations: ["op_does_not_exist", "op_low_reserve"] })),
    ).toEqual({ outcome: "owner_low_reserve" });
  });

  it("reads tx_bad_seq as a stale sequence", () => {
    expect(classifyRevocationError(horizonError({ transaction: "tx_bad_seq" }))).toEqual({ outcome: "stale_sequence" });
  });

  it("reads any other Horizon verdict, or a bare 4xx, as a definite rejection", () => {
    expect(classifyRevocationError(horizonError({ transaction: "tx_failed", operations: ["op_malformed"] })).outcome)
      .toBe("rejected");
    expect(classifyRevocationError(horizonError({ transaction: "tx_insufficient_fee" })).outcome).toBe("rejected");
    expect(classifyRevocationError({ response: { status: 400 } }).outcome).toBe("rejected");
  });

  it("reads a timeout, 5xx or network failure as unknown", () => {
    expect(classifyRevocationError({ response: { status: 504 } }).outcome).toBe("unknown");
    expect(classifyRevocationError(new Error("socket hang up")).outcome).toBe("unknown");
  });
});

describe("readChainSponsorship", () => {
  const sponsor = sponsorKp.publicKey();

  it("reports a missing account as not existing", async () => {
    const horizon = fakeHorizon({ ownerError: { response: { status: 404 } } });
    await expect(readChainSponsorship(ownerPub, sponsor, HALF_XLM, horizon as never)).resolves.toEqual({ exists: false });
  });

  it("propagates any other Horizon failure rather than reading it as unsponsored", async () => {
    const horizon = fakeHorizon({ ownerError: { response: { status: 503 } } });
    await expect(readChainSponsorship(ownerPub, sponsor, HALF_XLM, horizon as never)).rejects.toBeTruthy();
  });

  it("reads a zero-XLM account whose account and trustline this sponsor sponsors", async () => {
    // The probe's R1 right after sponsorship: num_sponsored 3, one subentry, 0 XLM.
    const owner = ownerAccount({ accountSponsor: sponsor, trustlineSponsor: sponsor, numSponsored: 3 });
    const chain = await readChainSponsorship(ownerPub, sponsor, HALF_XLM, fakeHorizon({ owner }) as never);
    expect(chain).toEqual({
      exists: true,
      sponsoredEntries: ["trustline", "account"],
      straySponsoredLines: 0,
      usdcBalanceUnits: 0n,
      usdcBuyingLiabilitiesUnits: 0n,
      ownerSpendableStroops: 0n,
    });
  });

  it("reports nothing sponsored once the entries are sponsored by nobody, or by someone else", async () => {
    const owner = ownerAccount({ accountSponsor: Keypair.random().publicKey(), trustlineSponsor: "", xlm: "5.0000000" });
    const chain = await readChainSponsorship(ownerPub, sponsor, HALF_XLM, fakeHorizon({ owner }) as never);
    expect(chain.exists && chain.sponsoredEntries).toEqual([]);
  });

  it("reports the account alone once the owner removed the trustline", async () => {
    const owner = ownerAccount({ accountSponsor: sponsor, trustlineSponsor: null, numSponsored: 2 });
    const chain = await readChainSponsorship(ownerPub, sponsor, HALF_XLM, fakeHorizon({ owner }) as never);
    expect(chain.exists && chain.sponsoredEntries).toEqual(["account"]);
  });

  it("computes what the owner could spend from the live base reserve", async () => {
    // 5 XLM, no sponsorship left: minimum balance is (2 + 1 subentry) × 0.5 = 1.5 XLM.
    const owner = ownerAccount({ trustlineSponsor: "", xlm: "5.0000000" });
    const chain = await readChainSponsorship(ownerPub, sponsor, HALF_XLM, fakeHorizon({ owner }) as never);
    expect(chain.exists && chain.ownerSpendableStroops).toBe(35_000_000n);
  });

  it("reads the USDC the trustline holds", async () => {
    const owner = ownerAccount({ accountSponsor: sponsor, trustlineSponsor: sponsor, usdcBalance: "12.5000000", numSponsored: 3 });
    const chain = await readChainSponsorship(ownerPub, sponsor, HALF_XLM, fakeHorizon({ owner }) as never);
    expect(chain.exists && chain.usdcBalanceUnits).toBe(125_000_000n);
  });

  it("counts a line to another asset that this sponsor sponsors as stray", async () => {
    const owner = ownerAccount({
      accountSponsor: sponsor,
      trustlineSponsor: null,
      extraLines: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: Keypair.random().publicKey(),
          balance: "0.0000000",
          sponsor,
        },
      ],
    });
    const chain = await readChainSponsorship(ownerPub, sponsor, HALF_XLM, fakeHorizon({ owner }) as never);
    expect(chain.exists && chain.straySponsoredLines).toBe(1);
    expect(chain.exists && chain.sponsoredEntries).toEqual(["account"]);
  });
});

describe("readRevokedEntries", () => {
  /** A Horizon whose operations for any transaction are `records`. */
  function horizonWith(records: unknown[] | Error) {
    const forTransaction = vi.fn(() => ({
      limit: () => ({
        call: async () => {
          if (records instanceof Error) throw records;
          return { records };
        },
      }),
    }));
    return { srv: { operations: () => ({ forTransaction }) } as never, forTransaction };
  }
  const usdc = () => `${usdcAsset().getCode()}:${usdcAsset().getIssuer()}`;
  const revokeTrustlineOp = (account = ownerPub, asset = usdc()) => ({
    type: "revoke_sponsorship",
    trustline_account_id: account,
    trustline_asset: asset,
  });
  const revokeAccountOp = (account = ownerPub) => ({ type: "revoke_sponsorship", account_id: account });

  it("reads both entries from a revocation that carried both, trustline first", async () => {
    const { srv, forTransaction } = horizonWith([revokeAccountOp(), revokeTrustlineOp()]);
    await expect(readRevokedEntries("HASH", ownerPub, srv)).resolves.toEqual(["trustline", "account"]);
    expect(forTransaction).toHaveBeenCalledWith("HASH");
  });

  it("reads the account alone from a revocation that carried only it", async () => {
    const { srv } = horizonWith([revokeAccountOp()]);
    await expect(readRevokedEntries("HASH", ownerPub, srv)).resolves.toEqual(["account"]);
  });

  it("ignores operations for another address, another asset, or of another type", async () => {
    const { srv } = horizonWith([
      revokeAccountOp(Keypair.random().publicKey()),
      revokeTrustlineOp(ownerPub, `USDC:${Keypair.random().publicKey()}`),
      { type: "payment", account_id: ownerPub },
    ]);
    await expect(readRevokedEntries("HASH", ownerPub, srv)).resolves.toEqual([]);
  });

  it("propagates a failed lookup", async () => {
    const { srv } = horizonWith(new Error("horizon down"));
    await expect(readRevokedEntries("HASH", ownerPub, srv)).rejects.toThrow("horizon down");
  });
});

describe("readSponsorshipOnChain", () => {
  const sponsor = sponsorKp.publicKey();

  it("reads a missing account as holding no trustline and nothing sponsored", async () => {
    const horizon = fakeHorizon({ ownerError: { response: { status: 404 } } });
    await expect(readSponsorshipOnChain(ownerPub, horizon as never)).resolves.toEqual({
      usdcTrustline: false,
      sponsoredEntries: [],
    });
  });

  it("propagates any other Horizon failure rather than reading the trustline as gone", async () => {
    const horizon = fakeHorizon({ ownerError: { response: { status: 503 } } });
    await expect(readSponsorshipOnChain(ownerPub, horizon as never)).rejects.toBeTruthy();
  });

  it("reads a trustline the owner removed, with the account still sponsored by the configured sponsor", async () => {
    const owner = ownerAccount({ accountSponsor: sponsor, trustlineSponsor: null, numSponsored: 2 });
    await expect(readSponsorshipOnChain(ownerPub, fakeHorizon({ owner }) as never)).resolves.toEqual({
      usdcTrustline: false,
      sponsoredEntries: ["account"],
    });
  });

  it("counts a trustline whoever pays its reserve", async () => {
    const owner = ownerAccount({ trustlineSponsor: "", xlm: "5.0000000" });
    await expect(readSponsorshipOnChain(ownerPub, fakeHorizon({ owner }) as never)).resolves.toEqual({
      usdcTrustline: true,
      sponsoredEntries: [],
    });
  });

  it("does not read a line to another USDC issuer as the trustline", async () => {
    const owner = ownerAccount({
      trustlineSponsor: null,
      extraLines: [
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: Keypair.random().publicKey(), balance: "0.0000000" },
      ],
    });
    await expect(readSponsorshipOnChain(ownerPub, fakeHorizon({ owner }) as never)).resolves.toEqual({
      usdcTrustline: false,
      sponsoredEntries: [],
    });
  });
});

describe("loadBaseReserveStroops", () => {
  it("reads the latest ledger's base reserve, as a number or a string", async () => {
    await expect(loadBaseReserveStroops(fakeHorizon() as never)).resolves.toBe(HALF_XLM);
    await expect(loadBaseReserveStroops(fakeHorizon({ baseReserve: "5000000" }) as never)).resolves.toBe(HALF_XLM);
  });

  it("refuses a missing or malformed base reserve", async () => {
    await expect(loadBaseReserveStroops(fakeHorizon({ baseReserve: "0" }) as never)).rejects.toThrow(/base_reserve/);
    await expect(loadBaseReserveStroops(fakeHorizon({ baseReserve: -1 }) as never)).rejects.toThrow(/base_reserve/);
  });
});
