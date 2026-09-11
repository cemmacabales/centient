import { Account, Asset, Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCoSignRequest, type CoSignerDeps } from "../cosigner-service";
import { signCoSignRequest, type NonceStore } from "../cosigner-transport";
import { buildPayoutPayment, signAsPlatform } from "../payout-envelope";
import type { LedgerPayout } from "../cosigner-ledger";
import { checkPayoutCap } from "@/lib/payout-cap";

const policy = Keypair.random();
const platform = Keypair.random();
const usdc = new Asset("USDC", Keypair.random().publicKey());
const destination = Keypair.random().publicKey();
const secret = "a".repeat(32);
const amountUnits = 25_000_000n;

beforeEach(() => {
  process.env.STELLAR_NETWORK = "testnet";
  process.env.STELLAR_USDC_ISSUER = usdc.getIssuer();
  process.env.COSIGNER_ISOLATION_LEVEL = "same-workspace";
  delete process.env.DAILY_PAYOUT_CAP_UNITS;
});

function nonces(): NonceStore {
  const seen = new Set<string>();
  return {
    take(nonce) {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    },
  };
}

/** The ledger row the service will independently read for this payout. */
function ledgerRow(overrides: Partial<LedgerPayout> = {}): LedgerPayout {
  return {
    kind: "submission",
    id: "sub-1",
    status: "pending",
    txHash: null,
    destination,
    amountUnits,
    ...overrides,
  };
}

function deps(overrides: Partial<CoSignerDeps> = {}): CoSignerDeps {
  return {
    policy,
    secret,
    nonces: nonces(),
    asset: usdc,
    capUnits: 200_000_000_000n,
    ledger: {
      readPayout: async () => ledgerRow(),
      broadcastVolumeSince: async () => 0n,
    },
    ...overrides,
  };
}

/** A platform-signed envelope plus the signed HTTP request that presents it. */
function signedRequest(
  overrides: {
    destination?: string;
    amountUnits?: bigint;
    referenceId?: string;
    stage?: "payment" | "fee_bump";
  } = {},
) {
  const amount = overrides.amountUnits ?? amountUnits;
  const to = overrides.destination ?? destination;
  const tx = buildPayoutPayment({
    sourceAccount: new Account(Keypair.random().publicKey(), "7"),
    destination: to,
    asset: usdc,
    amountUnits: amount,
  });
  signAsPlatform(tx, platform);
  const body = JSON.stringify({
    stage: overrides.stage ?? "payment",
    xdr: tx.toXDR(),
    destination: to,
    amountUnits: amount.toString(),
    reference: { kind: "submission", id: overrides.referenceId ?? "sub-1" },
  });
  return { body, headers: signCoSignRequest(body, secret) };
}

describe("handleCoSignRequest", () => {
  it("signs a payout the ledger independently agrees is owed", async () => {
    const { body, headers } = signedRequest();

    const response = await handleCoSignRequest(deps(), body, headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ publicKey: policy.publicKey() });
  });

  it("refuses an unauthenticated request before reading the ledger at all", async () => {
    // A caller who cannot authenticate must not be able to make the co-signer do
    // database work, so the transport check comes first.
    const { body } = signedRequest();
    let read = false;
    const response = await handleCoSignRequest(
      deps({
        ledger: {
          readPayout: async () => {
            read = true;
            return ledgerRow();
          },
          broadcastVolumeSince: async () => 0n,
        },
      }),
      body,
      {},
    );

    expect(response.status).toBe(401);
    expect(read).toBe(false);
  });

  it("refuses a payout the ledger has no row for", async () => {
    const { body, headers } = signedRequest();

    const response = await handleCoSignRequest(
      deps({ ledger: { readPayout: async () => null, broadcastVolumeSince: async () => 0n } }),
      body,
      headers,
    );

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/no ledger row/i);
  });

  it("refuses a destination the ledger does not record, however well signed", async () => {
    // The attack this exists to stop: a payout service that authenticates
    // correctly but asks to pay somebody else.
    const rogue = Keypair.random().publicKey();
    const { body, headers } = signedRequest({ destination: rogue });

    const response = await handleCoSignRequest(deps(), body, headers);

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/destination/i);
  });

  it("refuses an amount the ledger does not owe", async () => {
    const { body, headers } = signedRequest({ amountUnits: 900_000_000n });

    const response = await handleCoSignRequest(deps(), body, headers);

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/amount/i);
  });

  it("refuses once its own daily cap would be exceeded", async () => {
    // The co-signer's cap is configured separately from the payout service's, so
    // this is a genuinely second opinion rather than the same check run twice.
    const { body, headers } = signedRequest();

    const response = await handleCoSignRequest(
      deps({
        capUnits: 30_000_000n,
        ledger: {
          readPayout: async () => ledgerRow(),
          broadcastVolumeSince: async () => 20_000_000n,
        },
      }),
      body,
      headers,
    );

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/cap/i);
  });

  it("still refuses when the payout service cap is disabled", async () => {
    // A real app-side bypass must not affect the policy service's independently
    // configured decision.
    process.env.DAILY_PAYOUT_CAP_UNITS = "0";
    await expect(checkPayoutCap(amountUnits)).resolves.toMatchObject({
      allowed: true,
      cap: 0n,
    });
    const { body, headers } = signedRequest();

    const response = await handleCoSignRequest(
      deps({
        capUnits: 30_000_000n,
        ledger: {
          readPayout: async () => ledgerRow(),
          broadcastVolumeSince: async () => 20_000_000n,
        },
      }),
      body,
      headers,
    );

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/cap/i);
  });

  it("refuses to sign at all when the topology is not permitted on this network", async () => {
    process.env.STELLAR_NETWORK = "public";
    const { body, headers } = signedRequest();

    const response = await handleCoSignRequest(deps(), body, headers);

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).toMatch(/same-workspace/i);
  });

  it("refuses a replayed request even though it verified the first time", async () => {
    const shared = deps();
    const { body, headers } = signedRequest();

    expect((await handleCoSignRequest(shared, body, headers)).status).toBe(200);
    expect((await handleCoSignRequest(shared, body, headers)).status).toBe(401);
  });

  it("does not let two concurrent requests both spend the last of the cap", async () => {
    // Both requests read the broadcast volume before either has settled, so
    // without serialisation they both see room and both get signed — and the two
    // together exceed the cap this service exists to enforce. The signing
    // decision therefore runs one at a time.
    const shared = deps({
      capUnits: 30_000_000n,
      ledger: {
        // Answers for whichever payout it is asked about: these are two distinct
        // payouts, and the cap must be spent once by each.
        readPayout: async (reference) => ledgerRow({ id: reference.id }),
        // Nothing has broadcast yet: the race is between two in-flight requests,
        // not between a request and a settled payment.
        broadcastVolumeSince: async () => 0n,
      },
    });
    const first = signedRequest({ referenceId: "sub-1" });
    const second = signedRequest({ referenceId: "sub-2" });

    const [a, b] = await Promise.all([
      handleCoSignRequest(shared, first.body, first.headers),
      handleCoSignRequest(shared, second.body, second.headers),
    ]);

    const signed = [a, b].filter((r) => r.status === 200);
    expect(signed).toHaveLength(1);
    expect([a, b].find((r) => r.status !== 200)?.status).toBe(409);
  });

  it("re-reads the ledger inside the critical section, not before queuing for it", async () => {
    // A request can sit waiting for the lock while the row it validated acquires
    // a broadcast hash. Validating before queuing would sign against a ledger
    // state that is already stale by the time the signature is produced, so the
    // read and the signing must be the same critical section.
    const events: string[] = [];
    const shared = deps({
      ledger: {
        readPayout: async () => {
          events.push("read");
          return ledgerRow();
        },
        broadcastVolumeSince: async () => {
          events.push("cap");
          return 0n;
        },
      },
    });
    const first = signedRequest();
    const second = signedRequest();

    await Promise.all([
      handleCoSignRequest(shared, first.body, first.headers),
      handleCoSignRequest(shared, second.body, second.headers),
    ]);

    // Strictly alternating: each request reads and decides alone. Interleaved
    // reads ("read", "read", "cap", "cap") mean both validated against the same
    // pre-signature snapshot.
    expect(events).toEqual(["read", "cap", "read", "cap"]);
  });

  it("signs both stages of one payout when the payout itself fits under the cap", async () => {
    // A payout is co-signed twice — the payment envelope, then the fee bump —
    // both carrying the same amount. Charging the cap for each would make the
    // configured ceiling hold to about half its value, and would refuse the
    // second stage of a payout whose own amount fits. The cap is set here to
    // exactly the payout's amount, so there is no headroom to hide the bug in.
    const shared = deps({
      capUnits: amountUnits,
      ledger: {
        readPayout: async () => ledgerRow(),
        broadcastVolumeSince: async () => 0n,
      },
    });
    const payment = signedRequest({ stage: "payment" });
    const feeBump = signedRequest({ stage: "fee_bump" });

    expect((await handleCoSignRequest(shared, payment.body, payment.headers)).status).toBe(200);
    expect((await handleCoSignRequest(shared, feeBump.body, feeBump.headers)).status).toBe(200);
  });

  it("still charges the cap once per payout, not once per process", async () => {
    // The counterpart to the case above: making a payout's second stage free
    // must not make a *second payout* free. Two references, cap sized for one.
    const shared = deps({
      capUnits: amountUnits,
      ledger: {
        readPayout: async (reference) => ledgerRow({ id: reference.id }),
        broadcastVolumeSince: async () => 0n,
      },
    });
    const first = signedRequest({ referenceId: "sub-1" });
    const second = signedRequest({ referenceId: "sub-2" });

    expect((await handleCoSignRequest(shared, first.body, first.headers)).status).toBe(200);
    const refused = await handleCoSignRequest(shared, second.body, second.headers);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("daily cap reached");
  });

  it("never returns a transaction, only a detached signature", async () => {
    const { body, headers } = signedRequest();

    const response = await handleCoSignRequest(deps(), body, headers);

    expect(Object.keys(response.body as object).sort()).toEqual(["publicKey", "signature"]);
  });
});
