import * as Sentry from "@sentry/nextjs";
import prisma from "./prisma";
import { lookupTx, type TxLookup } from "./stellar/client";
import { usdcAsset } from "./stellar/config";
import { verifySettledPayout } from "./stellar/payout-verify";
import { refundSubmissionDebit } from "./payout-refund";
import { SUBMISSION_RETRY_BUDGET } from "./payout-retry-claim";
import { confirmAttempt } from "./payout-attempts";
import { hasRefundedSubmission } from "./campaign-balance";

// #40 D2: a payout still unreadable this long after it was created is paged.
const READ_ERROR_ALERT_AFTER_MS = 15 * 60_000;
// #40 D5: how often a held payout is looked up again.
const HELD_RECHECK_MS = 5 * 60_000;

/**
 * Leads the `payoutError` of a payout held because what applied on-chain does
 * not match the submission (D4). Such a row stays held for a human: the
 * reconciler never claims it again, and the reconcile report counts it.
 */
export const PAYOUT_MISMATCH = "payout mismatch:";

/** Rows not already held for a mismatch. NULL is spelled out: `NOT LIKE` is not true of NULL. */
const notMarkedMismatch = {
  OR: [{ payoutError: null }, { NOT: { payoutError: { startsWith: PAYOUT_MISMATCH } } }],
};

/** The two states a payout with a broadcast hash can be settled from. */
type SettledFrom = "sent" | "needs_reconciliation";

/**
 * Settle one `sent` submission against Horizon's answer for its hash (#40).
 *
 * The in-process reconciler loop is the only caller. It used to share these
 * rows with a cron route that applied different failure semantics to them; that
 * route is gone (D1), so this is the single place a broadcast submission payout
 * moves on Horizon's word.
 */
export async function reconcileSubmission(id: string, txHash: string): Promise<void> {
  // Horizon lookup (ST-1b) maps to three states: confirmed (successful tx),
  // failed (tx included but op failed), or not_found (404 — not yet visible).
  let lookup: TxLookup;
  try {
    lookup = await lookupTx(txHash);
  } catch (err: any) {
    // #40 D2: a read that throws (network, 5xx, a 400 on a malformed hash) says
    // nothing about the payment. The hash was broadcast and may have landed, so
    // neither the status nor the retry budget moves; only Horizon's answer may.
    const message = `Horizon read failed: ${err?.message ?? String(err)}`;
    const row = await prisma.submission.update({
      where: { id },
      data: { payoutError: message },
      select: { createdAt: true },
    });
    alertIfStale("submission", id, row?.createdAt, message);
    return;
  }

  if (lookup.status === "confirmed") {
    await settleConfirmedPayment(id, txHash, lookup.envelopeXdr, "sent");
  } else if (lookup.status === "failed") {
    await handBackFailedPayment(id, txHash, "sent");
  } else {
    // not_found: still pending. A submitted Stellar tx is only assigned a hash
    // once included in a ledger (≈5s finality), so a 404 here is Horizon
    // read-lag, not a drop. Leave the payout `sent` and re-check next pass —
    // the loop's claim already refreshed lastRetriedAt — without burning a
    // retry.
    console.log(`[reconciler] submission ${id} not yet visible on Horizon — leaving sent`);
  }
}

/**
 * #40 D4: Horizon says the envelope applied. Confirm it only if it paid what the
 * submission owed: the bound wallet, the payout amount in the configured USDC,
 * from the payout account, which also paid the fee bump. Anything else is held
 * as `needs_reconciliation` for a human, never confirmed.
 *
 * Without the payout account or USDC issuer configured there is nothing to hold
 * the envelope to, so nothing is confirmed: the row stays where it is and pages.
 *
 * A held row (D5) confirmed here was quarantined because the write recording it
 * failed, so its attempt was never confirmed and the user's totals never
 * raised; both land in the same write as its status. A held row whose envelope
 * does not match already carries the credit from when it was `sent`, and it
 * never reaches that write: it cannot match.
 */
async function settleConfirmedPayment(
  id: string,
  txHash: string,
  envelopeXdr: string,
  from: SettledFrom,
): Promise<void> {
  const sub = await prisma.submission.findUnique({
    where: { id },
    select: { userId: true, walletAddress: true, payoutAmountUnits: true },
  });
  if (!sub) return;

  let payoutAccount: string;
  let asset: ReturnType<typeof usdcAsset>;
  try {
    payoutAccount = process.env.STELLAR_PLATFORM_ACCOUNT?.trim() ?? "";
    if (!payoutAccount) throw new Error("STELLAR_PLATFORM_ACCOUNT is not configured");
    asset = usdcAsset();
  } catch (err) {
    const message = `cannot verify payout ${txHash}: ${(err as Error).message}`;
    await prisma.submission.update({ where: { id }, data: { payoutError: message } });
    console.error(`[reconciler] submission ${id}: ${message} — leaving it ${from}`);
    Sentry.captureMessage(`[reconciler] ${message}`, {
      level: "error",
      fingerprint: ["reconciler-cannot-verify"],
    });
    return;
  }

  const verdict = sub.walletAddress
    ? verifySettledPayout(envelopeXdr, {
        payoutAccount,
        destination: sub.walletAddress,
        amountUnits: sub.payoutAmountUnits,
        asset,
      })
    : ({ ok: false, mismatches: ["submission has no bound wallet to check the destination against"] } as const);

  // Every write is conditional on the row still being where it was read, under
  // this hash, so a second reader of the same answer changes nothing.
  const unchanged = { id, payoutStatus: from, payoutTxHash: txHash };
  if (verdict.ok) {
    if (from === "sent") {
      await prisma.submission.updateMany({
        where: unchanged,
        data: {
          payoutStatus: "confirmed",
          // F5: a transient Horizon read on an earlier pass wrote `payoutError`,
          // and nothing else clears it. Without this the row reads `confirmed`
          // under a failure message that is no longer true of it.
          payoutError: null,
          lastRetriedAt: new Date(),
        },
      });
    } else {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.submission.updateMany({
          where: unchanged,
          data: { payoutStatus: "confirmed", payoutError: null, lastRetriedAt: new Date() },
        });
        if (count === 0) return;
        await confirmAttempt(txHash, tx);
        await tx.user.update({
          where: { id: sub.userId },
          data: { totalEarnedUnits: { increment: sub.payoutAmountUnits }, submissionCount: { increment: 1 } },
        });
        await repairPayoutJobTuple(tx, id, txHash, sub.payoutAmountUnits);
      });
    }
    console.log(`[reconciler] confirmed submission ${id}`);
    return;
  }

  const reason = `${PAYOUT_MISMATCH} ${txHash} applied but does not match the submission: ${verdict.mismatches.join("; ")}`;
  const { count } = await prisma.submission.updateMany({
    where: from === "sent" ? unchanged : { ...unchanged, ...notMarkedMismatch },
    data: { payoutStatus: "needs_reconciliation", payoutError: reason },
  });
  if (count === 0) return;
  console.error(`[reconciler] submission ${id}: ${reason}`);
  Sentry.captureMessage(`[reconciler] submission ${id} payout mismatch`, {
    level: "error",
    extra: { txHash, mismatches: verdict.mismatches },
  });
}

/**
 * #40 D5 / F4: give a held payout's job the broadcast tuple its quarantine never
 * wrote.
 *
 * The worker's quarantine fails the job with no `txHash`, `amountUnits` or
 * `broadcastAt`, because the write that would have carried them is the one that
 * failed. Confirming the submission here without repairing that job leaves a
 * payment that provably applied on-chain invisible to everything that reads the
 * tuple: both rolling daily caps (`getPayoutActivitySince` and the co-signer's)
 * sum exactly those columns, so real spend is under-counted and the cap lets
 * more through than it should.
 *
 * `broadcastAt` is reconstructed, not invented. The attempt journal records an
 * envelope immediately before it is submitted, so its `createdAt` is the closest
 * true broadcast time there is; the job's own `completedAt` (written by the
 * quarantine) is the fallback, and only when neither exists does this fall back
 * to now. All three keep the payment inside a 24-hour rolling window that it
 * belongs in.
 *
 * Runs in the caller's transaction, so the tuple and the `confirmed` status land
 * together or not at all.
 */
async function repairPayoutJobTuple(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  submissionId: string,
  txHash: string,
  amountUnits: bigint,
): Promise<void> {
  const job = await tx.payoutJob.findUnique({
    where: { submissionId },
    select: { id: true, txHash: true, amountUnits: true, broadcastAt: true, completedAt: true },
  });
  if (job?.txHash === txHash && job.amountUnits !== null && job.broadcastAt !== null) return;

  const attempt = await tx.payoutAttempt.findUnique({
    where: { envelopeHash: txHash },
    select: { createdAt: true },
  });
  const broadcastAt = attempt?.createdAt ?? job?.completedAt ?? new Date();

  await tx.payoutJob.upsert({
    where: { submissionId },
    create: {
      type: "SUBMISSION_PAYOUT",
      submissionId,
      amountUnits,
      txHash,
      broadcastAt,
      status: "done",
      completedAt: new Date(),
    },
    update: {
      amountUnits,
      txHash,
      broadcastAt,
      status: "done",
      completedAt: new Date(),
      lastError: null,
    },
  });
  console.log(
    `[reconciler] submission ${submissionId}: repaired its payout job tuple for ${txHash} (broadcast ${broadcastAt.toISOString()})`,
  );
}

const FAILED_ON_CHAIN = "included and failed";

/**
 * #40 D3: Horizon says the envelope was included and failed, so nothing was
 * paid. The row still reads paid: its hash is stored, its attempt confirmed, and
 * the user's totals raised in the write that stored the hash. Undo exactly those
 * and hand the row back to the retry path, which builds the one replacement.
 *
 * The hand-back spends one retry. Without that, an envelope that fails on-chain
 * every time would be rebuilt forever. On the last retry the payout is over, and
 * the campaign debit is returned the way the retry path returns it.
 *
 * A held row (D5) is handed back the same way, with two differences. Its
 * credit was never raised, so there is none to undo. And a held row whose
 * campaign debit was already refunded stays held: paying it now would pay with
 * no funding behind it (#37).
 *
 * Everything is conditional on the row still being where it was read, under
 * this hash, in one transaction, so a second reader of the same failure changes
 * nothing.
 */
async function handBackFailedPayment(id: string, txHash: string, from: SettledFrom): Promise<void> {
  const handedBack = await prisma.$transaction(async (tx) => {
    const [sub] = await tx.$queryRaw<
      { userId: string; payoutAmountUnits: bigint; retryCount: number }[]
    >`
      SELECT "userId", "payoutAmountUnits", "retryCount" FROM "submissions"
      WHERE "id" = ${id} AND "payoutStatus" = ${from} AND "payoutTxHash" = ${txHash}
      FOR UPDATE
    `;
    if (!sub) return null;
    if (from === "needs_reconciliation" && (await hasRefundedSubmission(tx, id))) {
      console.warn(`[reconciler] held submission ${id}: ${FAILED_ON_CHAIN}, but already refunded — leaving it held`);
      return null;
    }

    const retryCount = sub.retryCount + 1;
    await tx.submission.update({
      where: { id },
      data: {
        payoutStatus: "failed",
        payoutTxHash: null,
        retryCount,
        lastRetriedAt: null,
        payoutError: `envelope ${txHash} ${FAILED_ON_CHAIN}; returned to the retry path`,
      },
    });
    // Confirmed when the hash was stored; open if the row predates that write.
    await tx.payoutAttempt.updateMany({
      where: { envelopeHash: txHash, status: { in: ["open", "confirmed"] } },
      data: { status: "void", outcome: FAILED_ON_CHAIN, resolvedAt: new Date() },
    });
    // Both payers credit in the write that records `sent`, so a `sent` row is
    // always credited and this undoes exactly its own credit. The floor is a
    // backstop for rows written before that was true.
    if (from === "sent") {
      await tx.user.updateMany({
        where: { id: sub.userId, totalEarnedUnits: { gte: sub.payoutAmountUnits }, submissionCount: { gt: 0 } },
        data: { totalEarnedUnits: { decrement: sub.payoutAmountUnits }, submissionCount: { decrement: 1 } },
      });
    }
    await tx.payoutJob.updateMany({
      where: { submissionId: id, txHash },
      data: { status: "failed", lastError: `${FAILED_ON_CHAIN} on Horizon` },
    });
    return { amount: sub.payoutAmountUnits, retryCount };
  });

  if (!handedBack) return;
  console.warn(`[reconciler] submission ${id}: envelope ${txHash} ${FAILED_ON_CHAIN} — returned to the retry path`);
  Sentry.captureMessage(`[reconciler] submission ${id} payout ${FAILED_ON_CHAIN} on-chain`, { level: "warning" });

  if (handedBack.retryCount >= SUBMISSION_RETRY_BUDGET) {
    await refundSubmissionDebit(id, handedBack.amount, "refund: payout failed on-chain with its retries spent");
  }
}

/**
 * #40 D5: settle a held payout (`needs_reconciliation` with a hash) on proof
 * only. Held rows are payments Horizon accepted that could not be recorded, so
 * nothing here assumes they did not pay:
 *
 * - applied, and matching the submission (D4) → `confirmed`;
 * - applied, not matching → stays held, marked `PAYOUT_MISMATCH`;
 * - included and failed → handed back to the retry path (D3);
 * - absent, or unreadable → stays held. Horizon accepted this envelope, so its
 *   absence means lost history (a testnet reset, a pruned Horizon), not a
 *   payment that never happened. Rebuilding on it would pay twice.
 */
export async function settleHeldPayment(id: string, txHash: string): Promise<void> {
  let lookup: TxLookup;
  try {
    lookup = await lookupTx(txHash);
  } catch (err: any) {
    console.warn(`[reconciler] held submission ${id}: Horizon read failed (${err?.message ?? String(err)}) — leaving it held`);
    return;
  }

  if (lookup.status === "confirmed") {
    await settleConfirmedPayment(id, txHash, lookup.envelopeXdr, "needs_reconciliation");
  } else if (lookup.status === "failed") {
    await handBackFailedPayment(id, txHash, "needs_reconciliation");
  } else {
    console.warn(`[reconciler] held submission ${id}: ${txHash} not on Horizon — leaving it held for a human`);
  }
}

/**
 * Take the next held payout due a recheck, or null. A row held for a mismatch
 * is never taken: what applied is known, and only a human can settle it. The
 * lease is taken conditionally, so two reconcilers never take the same row.
 */
export async function claimHeldPayment(): Promise<{ id: string; payoutTxHash: string } | null> {
  const dueBefore = new Date(Date.now() - HELD_RECHECK_MS);
  const next = await prisma.submission.findFirst({
    where: {
      payoutStatus: "needs_reconciliation",
      payoutTxHash: { not: null },
      AND: [notMarkedMismatch, { OR: [{ lastRetriedAt: null }, { lastRetriedAt: { lt: dueBefore } }] }],
    },
    orderBy: { lastRetriedAt: { sort: "asc", nulls: "first" } },
    select: { id: true, payoutTxHash: true, lastRetriedAt: true },
  });
  if (!next) return null;

  const { count } = await prisma.submission.updateMany({
    where: { id: next.id, payoutStatus: "needs_reconciliation", lastRetriedAt: next.lastRetriedAt },
    data: { lastRetriedAt: new Date() },
  });
  return count === 1 ? { id: next.id, payoutTxHash: next.payoutTxHash! } : null;
}

export function alertIfStale(kind: string, id: string, createdAt: Date | undefined, message: string): void {
  console.warn(`[reconciler] ${kind} ${id}: ${message} — leaving it for the next pass`);
  if (!createdAt || Date.now() - createdAt.getTime() < READ_ERROR_ALERT_AFTER_MS) return;
  Sentry.captureMessage(`[reconciler] ${kind} ${id} still unreadable on Horizon`, {
    level: "warning",
    fingerprint: ["reconciler-read-error", kind, id],
    extra: { message },
  });
}
