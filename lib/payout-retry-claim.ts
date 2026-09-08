/**
 * The retry claim's lease, defined once for every claimant that honours it.
 *
 * `lib/payout-service.ts` takes the lease inside its per-wallet advisory-lock
 * transaction; the admin retry route (`app/api/admin/submissions/[id]/retry`)
 * checks it before resetting the row it is about to claim. Both need the same
 * rule, and a lease two callers disagree about is not a lease — hence its own
 * module rather than a second copy of the arithmetic in a route handler.
 *
 * Kept free of imports on purpose: this is a rule about a timestamp, and every
 * claimant should be able to read it without pulling in the payout rail.
 */

/**
 * How long a claimed retry is considered in flight. Sized to the retry cron's
 * shortest backoff (`BASE_BACKOFF_MS`, 60s at retryCount 0) so the lease and the
 * backoff are exactly complementary: the cron will not offer a `failed`
 * submission again until 60s have passed, and the claim refuses it for the same
 * 60s. A lease can therefore never delay a retry the cron considers due.
 */
export const RETRY_CLAIM_LEASE_MS = 60_000;

/**
 * Is a retry already in flight for this submission?
 *
 * Nothing else about an in-flight row distinguishes it. The status still reads
 * `pending` or `failed` and `payoutTxHash` is still null until the broadcast
 * comes back, so `lastRetriedAt` is the only in-flight marker there is — which
 * is why a caller that resets it without checking can start a second broadcast
 * for a payout that is still on its way to Horizon.
 */
export function retryClaimIsLive(lastRetriedAt: Date | null | undefined): boolean {
  return !!lastRetriedAt && Date.now() - lastRetriedAt.getTime() < RETRY_CLAIM_LEASE_MS;
}
