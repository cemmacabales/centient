import { sendDedupedDiscordAlert, type HealthAlert } from "./health-alert";
import { CoSignerCapError, CoSignerUnavailableError } from "./stellar/cosigner-errors";

// #47 — how payers defer on a co-signer that answered "not now".
//
// The worker, the retry path and the withdrawal path all meet the same two
// answers, and must hold the payout rather than fail it: see
// `stellar/cosigner-errors.ts`. The retry delay and the alerts live here, so
// every payer says the same thing to whoever is on call.

/**
 * How long a job waits after the co-signer could not be reached. Short, because
 * nothing about the payout is wrong; long enough that a down co-signer is not
 * hammered by every queued job in turn.
 */
export const COSIGNER_RETRY_AFTER_MS = 30_000;

/** The alert for a co-signer answer a payer deferred on. */
export function coSignerDeferralAlert(err: CoSignerUnavailableError | CoSignerCapError): HealthAlert {
  if (err instanceof CoSignerUnavailableError) {
    return {
      key: "cosigner-unavailable",
      severity: "PAGE",
      title: "Payout co-signer is unavailable: payouts are held",
      lines: [
        err.message,
        `Payouts stay pending and retry every ${COSIGNER_RETRY_AFTER_MS / 1000}s. Nothing is refunded or sent on one signature.`,
      ],
    };
  }
  return {
    key: "cosigner-cap",
    severity: "PAGE",
    title: "Co-signer daily cap is reached: payouts are deferred",
    lines: [
      err.message,
      "The co-signer's cap runs on its own UTC-day window. Payouts stay pending and resume when it has room.",
    ],
  };
}

/**
 * Raise the alert without waiting on it. A slow Discord or Redis must never
 * delay a payer, and a failed delivery is the alerting path's to report.
 */
export function raiseCoSignerDeferralAlert(err: CoSignerUnavailableError | CoSignerCapError): void {
  sendDedupedDiscordAlert(coSignerDeferralAlert(err)).catch(() => {});
}
