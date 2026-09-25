// The co-signer's independent answer to "does Centient actually owe this?".
//
// Issue #8's requirement is that the second signature is not a second key held
// by the same party: the co-signer re-derives the payout from Centient's own
// task ledger and signs only what it independently agrees to pay. Everything
// here therefore reads the *row* and ignores what the request claims — the
// request is the thing being checked.
//
// This is deliberately a pure function over an already-read row. The read itself
// is a thin shell (`readLedgerPayout`) so that the decision — the part a payout
// depends on — is exhaustively testable without a database, and so the deployed
// service and its tests exercise the identical predicate.
import type { PayoutCoSignRequest, PayoutReference } from "./payout-envelope";

/**
 * The slice of a ledger row that decides whether a payout is owed. Both payout
 * paths are projected onto this shape: a per-submission reward and a lump-sum
 * payout job differ in which table they live in, not in what makes them payable.
 */
export interface LedgerPayout {
  kind: PayoutReference["kind"];
  id: string;
  /** The row's own payout status, in that table's vocabulary. */
  status: string;
  /** Non-null once Horizon accepted a payment for this row. */
  txHash: string | null;
  /**
   * #38: the hash of an envelope already signed for this row whose fate is not
   * yet settled — it may still land. Always null for a payout job, which is
   * not journalled.
   */
  openAttemptHash: string | null;
  /** Where the *ledger* says to pay — never where the request says. */
  destination: string | null;
  amountUnits: bigint | null;
}

/**
 * Statuses from which a payout may still legitimately be signed.
 *
 * A submission is normally signed from `pending`; `failed` is included because
 * `reprocessPayoutWithNonceSafety` retries a submission whose broadcast never
 * produced a hash, and refusing that would break a real payout rather than
 * prevent a fraudulent one. Every terminal status is excluded, and a row that
 * already carries a hash is refused regardless of status.
 */
const SIGNABLE_STATUSES: Readonly<Record<PayoutReference["kind"], readonly string[]>> = {
  submission: ["pending", "failed"],
  payout_job: ["queued", "processing"],
};

/**
 * Refuse to co-sign anything the ledger does not independently support.
 *
 * Throws with the reason on any disagreement; returns silently when the row and
 * the request describe the same payment. A `null` row is a refusal, not an
 * absence — the co-signer never signs a payout it cannot find.
 */
export function assertLedgerAgrees(
  row: LedgerPayout | null,
  request: PayoutCoSignRequest,
): void {
  const { kind, id } = request.reference;

  if (!row) {
    throw new Error(`payout co-signer: no ledger row for ${kind} ${id} — refusing to sign`);
  }
  if (row.kind !== kind) {
    throw new Error(
      `payout co-signer: ledger row ${id} is a ${row.kind}, but the request names a ${kind} — refusing to sign on a kind mismatch`,
    );
  }

  // Checked before status: a hash means the funds already left the wallet, which
  // is disqualifying whatever the row's status happens to say about it.
  if (row.txHash) {
    throw new Error(
      `payout co-signer: ${kind} ${id} already carries broadcast hash ${row.txHash} — refusing to sign a second payment for it`,
    );
  }
  // #38: an envelope signed earlier may still land. Until the payer settles it
  // by its hash, a new signature would be a second payment in waiting — the
  // double-pay a process killed mid-broadcast used to leave behind.
  if (row.openAttemptHash) {
    throw new Error(
      `payout co-signer: ${kind} ${id} has an unsettled envelope ${row.openAttemptHash} — refusing to sign another until it is settled`,
    );
  }
  if (!SIGNABLE_STATUSES[kind].includes(row.status)) {
    throw new Error(
      `payout co-signer: ${kind} ${id} has status "${row.status}", which is not signable (expected one of ${SIGNABLE_STATUSES[kind].join(", ")})`,
    );
  }

  if (!row.destination) {
    throw new Error(
      `payout co-signer: ${kind} ${id} records no destination — refusing to sign`,
    );
  }
  if (row.destination !== request.destination) {
    throw new Error(
      `payout co-signer: ${kind} ${id} pays destination ${row.destination} in the ledger, but the request asks to pay ${request.destination}`,
    );
  }

  if (row.amountUnits === null) {
    throw new Error(`payout co-signer: ${kind} ${id} records no amount — refusing to sign`);
  }
  if (row.amountUnits !== request.amountUnits) {
    throw new Error(
      `payout co-signer: ${kind} ${id} owes a ledger amount of ${row.amountUnits} units, but the request asks to pay ${request.amountUnits}`,
    );
  }
}

/**
 * The database surface this module needs, structurally typed rather than bound to
 * a concrete `PrismaClient`. The co-signer connects with its own read-only role,
 * so the client it passes in is not the application's — depending on the shape
 * instead of the instance is what lets the two stay separate.
 */
export interface LedgerReader {
  /** One SQL statement: the submission read below must be a single snapshot. */
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
  payoutJob: {
    aggregate(args: {
      _sum: { amountUnits: true };
      where: {
        broadcastAt: { gte: Date };
        txHash: { not: null };
        amountUnits: { not: null };
      };
    }): Promise<{ _sum: { amountUnits: bigint | null } }>;
    findUnique(args: {
      where: { id: string };
      select: { destinationAddress: true; amountUnits: true; status: true; txHash: true };
    }): Promise<{
      destinationAddress: string | null;
      amountUnits: bigint | null;
      status: string;
      txHash: string | null;
    } | null>;
  };
}

/**
 * Read the row a payout reference names and project it onto `LedgerPayout`.
 *
 * Only the columns the policy decision needs are selected, which keeps the
 * read-only grant the co-signer runs under as narrow as the query. A missing row
 * returns null; deciding what that means belongs to `assertLedgerAgrees`.
 */
export async function readLedgerPayout(
  client: LedgerReader,
  reference: PayoutReference,
): Promise<LedgerPayout | null> {
  if (reference.kind === "submission") {
    // The row and its open envelope in ONE statement, so one snapshot (#38
    // review). Read separately, a payer recording its payment in between turns
    // the row's "pending, no hash" and the envelope's "confirmed" into a stale
    // pair that looks unpaid with nothing in flight, and this signs again.
    const [row] = await client.$queryRaw<
      {
        walletAddress: string | null;
        payoutAmountUnits: bigint;
        payoutStatus: string;
        payoutTxHash: string | null;
        openAttemptHash: string | null;
      }[]
    >`
      SELECT s."walletAddress", s."payoutAmountUnits", s."payoutStatus", s."payoutTxHash",
             (SELECT a."envelopeHash" FROM "payout_attempts" a
               WHERE a."submissionId" = s."id" AND a."status" = 'open'
               LIMIT 1) AS "openAttemptHash"
      FROM "submissions" s
      WHERE s."id" = ${reference.id}
    `;
    if (!row) return null;
    return {
      kind: "submission",
      id: reference.id,
      status: row.payoutStatus,
      txHash: row.payoutTxHash,
      openAttemptHash: row.openAttemptHash,
      destination: row.walletAddress,
      amountUnits: row.payoutAmountUnits,
    };
  }

  const row = await client.payoutJob.findUnique({
    where: { id: reference.id },
    select: { destinationAddress: true, amountUnits: true, status: true, txHash: true },
  });
  if (!row) return null;
  return {
    kind: "payout_job",
    id: reference.id,
    status: row.status,
    txHash: row.txHash,
    openAttemptHash: null,
    destination: row.destinationAddress,
    amountUnits: row.amountUnits,
  };
}

/**
 * Units broadcast since `since`, as the co-signer's own cap sees them.
 *
 * Deliberately the same rule the payout service uses — a job counts once it
 * carries a hash, whatever its status became afterwards, because a hash means
 * Horizon accepted the payment and the funds have left the wallet. The
 * *independence* the second cap provides comes from being computed by a separate
 * process against a separately configured limit, not from counting differently:
 * a co-signer that measured spend some other way would disagree with the payout
 * service about the truth rather than about the policy.
 */
export async function readBroadcastVolumeSince(
  client: LedgerReader,
  since: Date,
): Promise<bigint> {
  const result = await client.payoutJob.aggregate({
    _sum: { amountUnits: true },
    where: {
      broadcastAt: { gte: since },
      txHash: { not: null },
      amountUnits: { not: null },
    },
  });
  return result._sum.amountUnits ?? 0n;
}
