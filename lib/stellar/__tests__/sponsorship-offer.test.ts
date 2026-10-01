import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// #170 — the sponsored-trustline envelope offered at sign-in, before the caller
// has a session. It must be unusable until the sponsor route signs it, and the
// route must sign only envelopes the sponsor built. Real throwaway keys exercise
// the signing and hashing; Horizon is mocked at the `server()` boundary.
const sponsorKp = Keypair.random();
process.env.STELLAR_PLATFORM_SECRET = sponsorKp.secret();
process.env.STELLAR_USDC_ISSUER = Keypair.random().publicKey();

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, server: vi.fn() };
});

import { networkPassphrase, server } from "../config";
import { buildSponsoredTrustlineTx, buildSponsorshipOffer, prepareSponsoredTrustline } from "../client";

const mockedServer = vi.mocked(server);

/** A Horizon with a funded sponsor. `missing` 404s; `submit` receives broadcasts. */
function fakeHorizon(o: { missing?: string; submit?: ReturnType<typeof vi.fn>; sequence?: string } = {}) {
  return {
    loadAccount: vi.fn(async (pub: string) => {
      if (pub === o.missing) throw { response: { status: 404 } };
      return Object.assign(new Account(pub, o.sequence ?? "1000"), {
        balances: [{ asset_type: "native", balance: "100.0000000", selling_liabilities: "0.0000000" }],
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
      });
    }),
    fetchBaseFee: vi.fn(async () => 100),
    submitTransaction: o.submit ?? vi.fn(async () => ({})),
    ledgers: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: [{ base_reserve_in_stroops: 5_000_000 }] }) }) }),
    }),
  };
}

/** Parse an envelope the way the wallet would receive it. */
const parse = (xdr: string) => TransactionBuilder.fromXDR(xdr, networkPassphrase()) as Transaction;

/** The contributor's co-signature on an offered envelope, as Freighter returns it. */
function coSign(xdr: string, recipient: Keypair): string {
  const tx = parse(xdr);
  tx.sign(recipient);
  return tx.toXDR();
}

/** Assert `prepareSponsoredTrustline` refuses as `invalid_sponsor_tx`. */
const refuses = (run: () => unknown) =>
  expect(run).toThrow(expect.objectContaining({ code: "invalid_sponsor_tx", retryable: false }));

beforeEach(() => {
  mockedServer.mockReset();
});

describe("#170 — buildSponsorshipOffer", () => {
  it("offers the same sandwich as the signed builder, but with no signature at all", async () => {
    const recipient = Keypair.random().publicKey();
    mockedServer.mockReturnValue(fakeHorizon({ missing: recipient }) as never);

    const offered = await buildSponsorshipOffer(recipient);
    const signed = await buildSponsoredTrustlineTx(recipient);

    const tx = parse(offered.xdr);
    expect(tx.signatures).toHaveLength(0);
    expect(offered.kind).toBe("account+trustline");
    expect(tx.operations.map((o) => o.type)).toEqual(parse(signed.xdr).operations.map((o) => o.type));
    expect(tx.source).toBe(sponsorKp.publicKey());
    expect(offered.expiresAt.getTime()).toBe(Number(tx.timeBounds!.maxTime) * 1000);
  });

  it("offers a trustline-only envelope for an account that exists", async () => {
    const recipient = Keypair.random().publicKey();
    mockedServer.mockReturnValue(fakeHorizon() as never);
    await expect(buildSponsorshipOffer(recipient)).resolves.toMatchObject({ kind: "trustline" });
  });
});

describe("#170 — prepareSponsoredTrustline with an offer", () => {
  it("adds the sponsor's signature to an offered envelope the contributor signed, and broadcasts it", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(fakeHorizon({ missing: recipient.publicKey() }) as never);
    const offered = await buildSponsorshipOffer(recipient.publicKey());

    const submit = vi.fn(async (_tx: FeeBumpTransaction) => ({}));
    mockedServer.mockReturnValue(fakeHorizon({ submit }) as never);
    const prepared = prepareSponsoredTrustline(coSign(offered.xdr, recipient), recipient.publicKey(), offered.offer);
    await prepared.submit();

    const bump = submit.mock.calls[0][0] as FeeBumpTransaction;
    const inner = bump.innerTransaction;
    expect(prepared.hash).toBe(parse(offered.xdr).hash().toString("hex"));
    expect(inner.signatures).toHaveLength(2);
    expect(inner.signatures.some((s) => sponsorKp.verify(inner.hash(), s.signature()))).toBe(true);
    expect(inner.signatures.some((s) => recipient.verify(inner.hash(), s.signature()))).toBe(true);
  });

  it("refuses an offered envelope sent back without its offer: it carries no sponsor signature", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(fakeHorizon() as never);
    const offered = await buildSponsorshipOffer(recipient.publicKey());

    refuses(() => prepareSponsoredTrustline(coSign(offered.xdr, recipient), recipient.publicKey()));
  });

  it("refuses the offer of a different envelope", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(fakeHorizon() as never);
    const offered = await buildSponsorshipOffer(recipient.publicKey());
    // The same recipient, a moment later: another sequence, so another hash.
    mockedServer.mockReturnValue(fakeHorizon({ sequence: "2000" }) as never);
    const other = await buildSponsorshipOffer(recipient.publicKey());

    refuses(() => prepareSponsoredTrustline(coSign(offered.xdr, recipient), recipient.publicKey(), other.offer));
  });

  it("refuses an envelope the caller built to the same shape, whatever offer comes with it", () => {
    // Shape-valid, sourced from the sponsor, never issued by it.
    const recipient = Keypair.random();
    const r = recipient.publicKey();
    const forged = new TransactionBuilder(new Account(sponsorKp.publicKey(), "1000"), {
      fee: "100",
      networkPassphrase: networkPassphrase(),
    })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: r }))
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", process.env.STELLAR_USDC_ISSUER!), source: r }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: r }))
      .setTimeout(180)
      .build();
    forged.sign(recipient);

    refuses(() => prepareSponsoredTrustline(forged.toXDR(), r, "made-up-tag"));
    refuses(() => prepareSponsoredTrustline(forged.toXDR(), r, ""));
  });

  it("refuses an offered envelope for someone other than the session's wallet", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(fakeHorizon() as never);
    const offered = await buildSponsorshipOffer(recipient.publicKey());

    refuses(() =>
      prepareSponsoredTrustline(coSign(offered.xdr, recipient), Keypair.random().publicKey(), offered.offer),
    );
  });

  it("refuses an offered envelope the contributor never signed", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(fakeHorizon() as never);
    const offered = await buildSponsorshipOffer(recipient.publicKey());

    refuses(() => prepareSponsoredTrustline(offered.xdr, recipient.publicKey(), offered.offer));
  });

  it("does not sign twice when the envelope already carries the sponsor's signature", async () => {
    const recipient = Keypair.random();
    mockedServer.mockReturnValue(fakeHorizon() as never);
    const offered = await buildSponsorshipOffer(recipient.publicKey());
    const both = parse(offered.xdr);
    both.sign(sponsorKp, recipient);

    const submit = vi.fn(async (_tx: FeeBumpTransaction) => ({}));
    mockedServer.mockReturnValue(fakeHorizon({ submit }) as never);
    await prepareSponsoredTrustline(both.toXDR(), recipient.publicKey(), offered.offer).submit();

    expect((submit.mock.calls[0][0] as FeeBumpTransaction).innerTransaction.signatures).toHaveLength(2);
  });
});
