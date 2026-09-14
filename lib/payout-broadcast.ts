import { sendDedupedDiscordAlert } from "./health-alert";

export interface AcceptedPayment {
  reference: string;
  txHash: string;
  amountUnits: bigint;
  broadcastAt: Date;
}

const PERSISTENCE_ATTEMPTS = 3;

/**
 * Run a bounded, idempotent write, reporting whether it landed. Database errors
 * are swallowed deliberately: they can carry connection credentials, and no
 * caller here may turn a write failure into a payment failure.
 */
async function attemptWrite(write: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < PERSISTENCE_ATTEMPTS; attempt++) {
    try {
      await write();
      return true;
    } catch {
      // Retry the same idempotent write; never the broadcast.
    }
  }
  return false;
}

/**
 * Page for manual reconciliation of a payment that settled on-chain but could
 * not be recorded.
 *
 * `retriesBlocked` says whether the record was successfully taken out of every
 * automatic retry path. When it is false the same payment can still be
 * re-broadcast by a sweep, which is a live double-payment risk and has to be
 * stated in the page rather than left for the operator to infer.
 */
export async function pageAcceptedPayment(
  payment: AcceptedPayment,
  retriesBlocked = true,
): Promise<void> {
  console.error("[payout] accepted payment requires manual reconciliation", {
    reference: payment.reference,
    txHash: payment.txHash,
    amountUnits: payment.amountUnits.toString(),
    broadcastAt: payment.broadcastAt.toISOString(),
    retriesBlocked,
  });
  try {
    await sendDedupedDiscordAlert({
      key: "payout-persistence-unavailable",
      severity: "PAGE",
      title: "Accepted payout requires manual reconciliation",
      lines: [
        `Reference: ${payment.reference}`,
        `Transaction: ${payment.txHash}`,
        `Amount units: ${payment.amountUnits}`,
        `Accepted at: ${payment.broadcastAt.toISOString()}`,
        "Database recording or bookkeeping failed. Reconcile before any refund or reissue.",
        retriesBlocked
          ? "Automatic retry is blocked for this record."
          : "WARNING: automatic retry is NOT blocked — this payment can be re-broadcast. Intervene now.",
      ],
    });
  } catch {
    console.error("[payout] reconciliation PAGE delivery unavailable");
  }
}

/**
 * Take an accepted payment out of every automatic retry path, then page.
 *
 * Suppressing the refund is not enough on its own. A withdrawal job left
 * `processing` with a dead heartbeat is reclaimed by `claimNextJob` within a
 * minute, and a submission left `pending` with no stored hash is re-sent by the
 * retry cron — either one re-broadcasts a payment that already settled, long
 * before a human reads the page.
 */
export async function abandonAcceptedPayment(
  payment: AcceptedPayment,
  quarantine: () => Promise<unknown>,
): Promise<void> {
  await pageAcceptedPayment(payment, await attemptWrite(quarantine));
}

/**
 * Record an accepted payment's broadcast tuple, or quarantine and page.
 *
 * Retries only the idempotent recording of the same tuple — never the broadcast
 * and never the credits. Returns whether the caller may continue; false means
 * the payment stands, is now excluded from automatic retry, and is awaiting a
 * human.
 */
export async function persistAcceptedPayment(
  payment: AcceptedPayment,
  persist: () => Promise<unknown>,
  quarantine: () => Promise<unknown>,
): Promise<boolean> {
  if (await attemptWrite(persist)) return true;
  await abandonAcceptedPayment(payment, quarantine);
  return false;
}
