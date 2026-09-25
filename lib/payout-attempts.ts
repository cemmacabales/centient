import prisma from "./prisma";
import { getTxStatus, latestLedgerCloseMs } from "./stellar/client";
import type { PayoutAttemptJournal } from "./stellar/payout-submitter";

// #38 — one durable payout outcome per validated submission.
//
// The submission id is the idempotency key. Every envelope signed under it is
// recorded in `payout_attempts` before it is submitted, and at most one may be
// `open` (a partial unique index). An open envelope may still land on-chain, so
// before any payer builds another it settles the open one by its hash. The
// co-signer independently refuses to sign while one is open.

/** Statuses a submission may be paid from — the co-signer's signable set. */
const PAYABLE_STATUSES = ["pending", "failed"];

/** How long a payer waits before looking again at an envelope it cannot yet settle. */
const RECHECK_AFTER_MS = 15_000;

/** The `payout_attempts` store behind `submitMultisigPayout`'s journal, for one submission. */
export function submissionAttemptJournal(submissionId: string): PayoutAttemptJournal {
  return {
    // Only while the submission is still payable, checked under a lock on its
    // row. The one-open index stops two live envelopes; this stops one opening
    // after another has already paid. A payer that took its signatures early
    // would otherwise open the moment the first envelope is confirmed. The lock
    // makes it wait for the write that records a payment and then see it.
    async open({ hash, expiresAt }) {
      await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ payoutStatus: string; payoutTxHash: string | null }[]>`
          SELECT "payoutStatus", "payoutTxHash" FROM "submissions" WHERE "id" = ${submissionId} FOR UPDATE
        `;
        if (!row || row.payoutTxHash !== null || !PAYABLE_STATUSES.includes(row.payoutStatus)) {
          throw new Error(
            `payout attempt: submission ${submissionId} is not payable (${row ? `status ${row.payoutStatus}${row.payoutTxHash ? `, hash ${row.payoutTxHash}` : ""}` : "not found"}) — refusing to open envelope ${hash}`,
          );
        }
        await tx.payoutAttempt.create({ data: { submissionId, envelopeHash: hash, expiresAt } });
      });
    },
    void: voidAttempt,
  };
}

/**
 * Mark the envelope that paid a submission as `confirmed`. Callers put this in
 * the same write that records the payment's hash on the submission, so the two
 * never disagree about whether it applied.
 */
export function confirmAttempt(
  envelopeHash: string,
  client: Pick<typeof prisma, "payoutAttempt"> = prisma,
) {
  return client.payoutAttempt.updateMany({
    where: { envelopeHash, status: "open" },
    data: { status: "confirmed", outcome: "applied", resolvedAt: new Date() },
  });
}

/**
 * What a payer may do about a submission's open envelope:
 * - `clear`: nothing is open, or it provably never applied; build a new one.
 * - `paid`: it applied, under `hash`; record that (confirming the attempt in
 *   the same write, via `confirmAttempt`) and build nothing.
 * - `wait`: it may still apply; build nothing before `until`.
 */
export type Settlement =
  | { kind: "clear" }
  | { kind: "paid"; hash: string }
  | { kind: "wait"; until: Date; reason: string };

export interface SettlementHorizon {
  getTxStatus(hash: string): Promise<"confirmed" | "failed" | "not_found">;
  latestLedgerCloseMs(): Promise<number | null>;
}

const liveHorizon: SettlementHorizon = { getTxStatus, latestLedgerCloseMs };

/**
 * Settle a submission's open envelope, if it has one, by asking Horizon about
 * that exact transaction. Run by every payer after it takes the submission's
 * claim and before it builds anything.
 *
 * The proof that an absent envelope is dead is the submitter's
 * (`resolveAmbiguousSubmit`): Horizon must report it absent in a lookup made
 * *after* a ledger closed strictly past its `maxTime`. An absence seen before
 * that proves nothing — it may be included in the gap — so the order is: see
 * the post-expiry ledger, then look again. A Horizon error is never evidence of
 * absence; it means wait.
 */
export async function settleOpenAttempt(
  submissionId: string,
  horizon: SettlementHorizon = liveHorizon,
): Promise<Settlement> {
  const attempt = await prisma.payoutAttempt.findFirst({
    where: { submissionId, status: "open" },
  });
  if (!attempt) return { kind: "clear" };

  const hash = attempt.envelopeHash;
  const recheck = (reason: string): Settlement => ({
    kind: "wait",
    until: new Date(Math.max(Date.now() + RECHECK_AFTER_MS, attempt.expiresAt.getTime() + RECHECK_AFTER_MS)),
    reason,
  });
  const settleBy = async (status: "confirmed" | "failed" | "not_found", absentOutcome: string | null) => {
    // Left open on purpose: it is confirmed only in the caller's write that
    // records this hash on the submission. Confirming it here first would let a
    // process that dies in between leave a submission with no hash and no open
    // attempt, which the next payer would build a new envelope for.
    if (status === "confirmed") return { kind: "paid", hash } as const;
    if (status === "failed") {
      await voidAttempt(hash, "included and failed");
      return { kind: "clear" } as const;
    }
    if (absentOutcome) {
      await voidAttempt(hash, absentOutcome);
      return { kind: "clear" } as const;
    }
    return null;
  };

  let first: "confirmed" | "failed" | "not_found";
  try {
    first = await horizon.getTxStatus(hash);
  } catch {
    return recheck("Horizon lookup failed");
  }
  const early = await settleBy(first, null);
  if (early) return early;

  // Absent. Only a ledger that closed after maxTime can make that final.
  const ledgerCloseMs = await horizon.latestLedgerCloseMs().catch(() => null);
  if (ledgerCloseMs === null || ledgerCloseMs <= attempt.expiresAt.getTime()) {
    return recheck("envelope absent but still inside its time bounds");
  }

  // This lookup follows that ledger, so an envelope included before maxTime
  // would now be visible.
  let second: "confirmed" | "failed" | "not_found";
  try {
    second = await horizon.getTxStatus(hash);
  } catch {
    return recheck("Horizon lookup failed");
  }
  return (await settleBy(second, "expired unincluded")) ?? recheck("unreachable");
}

async function voidAttempt(envelopeHash: string, outcome: string) {
  await prisma.payoutAttempt.updateMany({
    where: { envelopeHash, status: "open" },
    data: { status: "void", outcome, resolvedAt: new Date() },
  });
}
