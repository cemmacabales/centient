import { sendDedupedDiscordAlert } from "./health-alert";

export interface AcceptedPayment {
  reference: string;
  txHash: string;
  amountUnits: bigint;
  broadcastAt: Date;
}

/** Once a hash is returned, persistence failures must never become payment failures. */
export async function pageAcceptedPayment(payment: AcceptedPayment): Promise<void> {
  console.error("[payout] accepted payment requires manual reconciliation", {
    reference: payment.reference,
    txHash: payment.txHash,
    amountUnits: payment.amountUnits.toString(),
    broadcastAt: payment.broadcastAt.toISOString(),
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
      ],
    });
  } catch {
    console.error("[payout] reconciliation PAGE delivery unavailable");
  }
}

/** Retry only idempotent recording of the same tuple, never broadcast or credits. */
export async function persistAcceptedPayment(
  payment: AcceptedPayment,
  persist: () => Promise<unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await persist();
      return true;
    } catch {
      // Do not pass database errors (which may contain connection credentials) on.
    }
  }
  await pageAcceptedPayment(payment);
  return false;
}
