import { PostHog } from "posthog-node";
import { unitsToUsdcString } from "./stellar/config";
import type { PayoutReference } from "./stellar/payout-envelope";

/** The PostHog event every on-chain payout attempt is recorded under. */
export const PAYOUT_TRANSACTION_EVENT = "payout_transaction";

let _client: PostHog | null | undefined;

/**
 * The server-side PostHog client, or null when no project key is configured.
 *
 * Payouts settle in the worker and in cron routes, never in the browser, so the
 * client-side `posthog-js` instance cannot see them. The project key is the same
 * public one the browser uses. `flushAt: 1` sends each event as it is captured:
 * payouts are rare enough that batching buys nothing, and a batch still queued
 * when a cron route returns would be lost.
 */
function client(): PostHog | null {
  if (_client !== undefined) return _client;
  const key = process.env.POSTHOG_KEY?.trim() || process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  _client = key
    ? new PostHog(key, {
        host: process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
        flushAt: 1,
        flushInterval: 0,
      })
    : null;
  return _client;
}

export interface PayoutTransaction {
  walletAddress: string;
  amountUnits: bigint;
  reference: PayoutReference;
  /** Null when the payout failed before a transaction hash was known. */
  txHash: string | null;
  success: boolean;
  errorCode?: string;
}

/**
 * Record one payout attempt in PostHog, never throwing.
 *
 * The wallet is the distinct id, so every transfer to the same `G…` address lands
 * on one person and can be listed and sorted together. This is a deliberate
 * exception to the no-wallet-address rule in `lib/analytics.ts`: that rule keeps
 * browser events from linking a person to a wallet, while a payout's destination
 * and hash are already public on the Stellar ledger. Analytics must never turn
 * into a payment failure, so every error here is swallowed.
 */
export function capturePayoutTransaction(tx: PayoutTransaction): void {
  try {
    const posthog = client();
    if (!posthog) return;
    posthog.capture({
      distinctId: tx.walletAddress,
      event: PAYOUT_TRANSACTION_EVENT,
      properties: {
        wallet_address: tx.walletAddress,
        amount_usdc: Number(unitsToUsdcString(tx.amountUnits)),
        amount_units: tx.amountUnits.toString(),
        tx_hash: tx.txHash,
        success: tx.success,
        status: tx.success ? "success" : "failed",
        error_code: tx.errorCode ?? null,
        reference_kind: tx.reference.kind,
        reference_id: tx.reference.id,
      },
    });
  } catch {
    // Analytics is best-effort; the payout outcome already stands.
  }
}

/** Test-only: drop the memoized client so a changed environment is re-read. */
export function resetAnalyticsClientForTests(): void {
  _client = undefined;
}
