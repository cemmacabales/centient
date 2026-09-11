// The independent policy co-signer's request handler (issue #8).
//
// This is the whole point of the second signature: the co-signer is handed an
// envelope and a claim about what it pays, and it agrees only after deciding for
// itself, from Centient's own task ledger, that the payment is owed. It trusts
// the request for exactly one thing — which ledger row to look at.
//
// The order of the checks is part of the design. Transport authentication runs
// first so an unauthenticated caller cannot make the service do database work;
// the isolation gate runs before any signing so a topology this network does not
// permit fails closed; and the ledger check runs before the cap so a forged
// payout is refused as forged rather than as over-budget.
import { Mutex } from "async-mutex";
import type { Asset, Keypair } from "@stellar/stellar-sdk";
import { assertIsolationPermitted } from "./cosigner-isolation";
import { assertLedgerAgrees, type LedgerPayout } from "./cosigner-ledger";
import { verifyCoSignRequest, type NonceStore } from "./cosigner-transport";
import { assertEnvelopeMatchesRequest } from "./cosigner-verify";
import type { PayoutCoSignRequest, PayoutReference } from "./payout-envelope";

/** The ledger port, so the handler never holds a database client of its own. */
export interface CoSignerLedger {
  readPayout(reference: PayoutReference): Promise<LedgerPayout | null>;
  /** Units already broadcast since `since`, for the independent cap. */
  broadcastVolumeSince(since: Date): Promise<bigint>;
}

export interface CoSignerDeps {
  policy: Keypair;
  secret: string;
  nonces: NonceStore;
  asset: Asset;
  /** This service's own cap, configured separately from the payout service's. */
  capUnits: bigint;
  ledger: CoSignerLedger;
  now?: () => Date;
}

export interface CoSignerResponse {
  status: number;
  body: unknown;
}

/** The payout a commitment belongs to — the unit the cap is spent in, not the request. */
function commitmentKey(reference: PayoutReference): string {
  return `${reference.kind}:${reference.id}`;
}

/**
 * Units this process has signed but not yet seen broadcast.
 *
 * Without this the cap is checked against a number that cannot yet reflect the
 * decision being made: two requests arriving together both read the same
 * broadcast volume, both find room, and both are signed — together exceeding the
 * limit this service exists to enforce.
 *
 * Commitments are held per payout rather than per request, because one payout
 * asks for two signatures: `buildCoSignSubmit` presents the same amount once as
 * `payment` and again as `fee_bump`. Counting each would spend the payout's
 * amount twice, so the configured cap would hold to about half its value and a
 * payout that fits under the cap could have its second stage refused. A payout
 * is committed once, and its second stage neither adds a commitment nor is
 * charged for the one it already has.
 *
 * A durable, shared reservation would be the general answer, and it is
 * deliberately not what happens here: writing reservations would require giving
 * the co-signer write access to the database, and the read-only credential is
 * the one boundary this topology actually enforces (ADR-0001). Trading it away
 * to tighten a backstop cap would cost more than it buys. The in-process
 * commitment below closes the window within the single replica this service is
 * documented to run as, and the payout service holds the primary cap regardless.
 */
class SignedCommitments {
  private readonly entries: { at: number; key: string; units: bigint }[] = [];

  /** Drop anything whose envelope can no longer settle. Entries are pushed in time order. */
  private expire(now: number): void {
    while (this.entries.length > 0 && now - this.entries[0].at > SIGNED_COMMITMENT_TTL_MS) {
      this.entries.shift();
    }
  }

  /**
   * Total still in flight. `excluding` is the payout currently being decided: its
   * own earlier commitment is not counted against it, so the second stage of a
   * payout is measured against the same headroom the first stage was.
   */
  outstanding(now: number, excluding?: string): bigint {
    this.expire(now);
    return this.entries.reduce(
      (sum, entry) => (entry.key === excluding ? sum : sum + entry.units),
      0n,
    );
  }

  /** Commit a payout's amount once. A payout already committed in the window is left alone. */
  record(now: number, key: string, units: bigint): void {
    this.expire(now);
    if (this.entries.some((entry) => entry.key === key)) return;
    this.entries.push({ at: now, key, units });
  }
}

/**
 * How long a signed envelope can still reach the network.
 *
 * Payout envelopes carry 180s timebounds, so a signature older than that has
 * either settled — and is therefore counted by `broadcastVolumeSince` — or can
 * never settle at all. It is the natural life of a commitment this service has
 * made but cannot yet observe.
 */
const SIGNED_COMMITMENT_TTL_MS = 180_000;

/** Midnight UTC of the day `at` falls in — the window the daily cap is measured over. */
function startOfDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Parse the wire body into a signing request.
 *
 * `amountUnits` arrives as a decimal string and is converted with `BigInt`, which
 * throws on anything that is not an exact integer — a float, an empty string, or
 * a number that lost precision on the way here is rejected rather than rounded.
 */
function parseRequest(raw: string): PayoutCoSignRequest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { stage, xdr, destination, amountUnits, reference } = parsed;

  if (stage !== "payment" && stage !== "fee_bump") {
    throw new Error(`unknown signing stage "${String(stage)}"`);
  }
  if (typeof xdr !== "string" || !xdr) throw new Error("request carries no envelope");
  if (typeof destination !== "string" || !destination) {
    throw new Error("request carries no destination");
  }
  if (typeof amountUnits !== "string") {
    throw new Error("amountUnits must be a decimal string, not a JSON number");
  }
  const ref = reference as PayoutReference | undefined;
  if (!ref || (ref.kind !== "submission" && ref.kind !== "payout_job") || !ref.id) {
    throw new Error("request carries no usable payout reference");
  }

  return { stage, xdr, destination, amountUnits: BigInt(amountUnits), reference: ref };
}

function fail(status: number, error: string): CoSignerResponse {
  return { status, body: { error } };
}

/**
 * Decide one signing request and produce the detached signature, or the reason
 * for refusing it. Never throws for an expected refusal — the caller is an HTTP
 * server and every refusal is a status code plus a reason worth logging.
 */
/**
 * One signing decision at a time, per service instance. Keyed on the deps object
 * so each deployment — and each test — gets its own, rather than sharing module
 * state across everything that ever imports this file.
 */
const serialisers = new WeakMap<CoSignerDeps, { lock: Mutex; committed: SignedCommitments }>();

function serialiserFor(deps: CoSignerDeps) {
  let existing = serialisers.get(deps);
  if (!existing) {
    existing = { lock: new Mutex(), committed: new SignedCommitments() };
    serialisers.set(deps, existing);
  }
  return existing;
}

export async function handleCoSignRequest(
  deps: CoSignerDeps,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
): Promise<CoSignerResponse> {
  try {
    verifyCoSignRequest(rawBody, headers, deps.secret, { nonces: deps.nonces });
  } catch (err) {
    return fail(401, (err as Error).message);
  }

  // Checked per request rather than at boot: the network or the declared topology
  // can change under a running process, and signing is the thing that must stop.
  try {
    assertIsolationPermitted();
  } catch (err) {
    return fail(503, (err as Error).message);
  }

  let request: PayoutCoSignRequest;
  try {
    request = parseRequest(rawBody);
  } catch (err) {
    return fail(400, (err as Error).message);
  }

  try {
    // The envelope check needs no ledger and no lock: it establishes only that
    // the XDR pays what the request says, which is true or false on its own.
    const transaction = assertEnvelopeMatchesRequest(request, deps.asset);

    // Everything that depends on ledger state happens as one critical section —
    // read, decide, sign. A request can wait here while the row it would have
    // validated acquires a broadcast hash, so validating before queuing would
    // sign against a snapshot that is already stale by the time the signature
    // exists. The cap has the same shape: a signature this service has already
    // issued is a commitment even though no ledger anywhere reflects it yet.
    const { lock, committed } = serialiserFor(deps);
    return await lock.runExclusive(async () => {
      assertLedgerAgrees(await deps.ledger.readPayout(request.reference), request);

      const now = (deps.now ?? (() => new Date()))();
      const key = commitmentKey(request.reference);
      const broadcast = await deps.ledger.broadcastVolumeSince(startOfDay(now));
      const outstanding = committed.outstanding(now.getTime(), key);
      const spent = broadcast + outstanding;
      if (spent + request.amountUnits > deps.capUnits) {
        return fail(
          409,
          `payout co-signer: daily cap reached — ${broadcast} units broadcast plus ${outstanding} signed and in flight plus ${request.amountUnits} requested exceeds the co-signer's cap of ${deps.capUnits}`,
        );
      }

      const signature = deps.policy.sign(transaction.hash()).toString("base64");
      committed.record(now.getTime(), key, request.amountUnits);
      return {
        status: 200,
        body: { publicKey: deps.policy.publicKey(), signature },
      };
    });
  } catch (err) {
    return fail(409, (err as Error).message);
  }
}
