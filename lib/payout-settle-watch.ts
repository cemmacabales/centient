/** Statuses at which the worker has paid the answer and raised `totalEarnedUnits`. */
const PAID_STATUSES = new Set(["sent", "confirmed"]);

export interface SettleWatchOptions {
  fetchImpl?: (url: string) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Polls before giving up; with the default interval, about two minutes. */
  maxAttempts?: number;
  /** Checked before each poll, so a logout stops the watch. */
  isCancelled?: () => boolean;
}

/**
 * Wait for one accepted answer's on-chain payout to be sent, reading its status
 * from `GET /api/submissions/[id]`. Resolves true once it is paid, and false if
 * it ends unpaid, cannot be read, is cancelled, or is still pending when the
 * attempts run out.
 *
 * #39: "Total earned" reads `totalEarnedUnits`, which the worker raises only
 * after paying, so the page refreshes earnings when this resolves true. The
 * success screen does not show this progress; it only keeps the total current.
 */
export async function waitForPayoutToSettle(
  submissionId: string,
  {
    fetchImpl = (url) => fetch(url),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 3000,
    maxAttempts = 40,
    isCancelled = () => false,
  }: SettleWatchOptions = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(intervalMs);
    if (isCancelled()) return false;
    let status: unknown;
    try {
      const res = await fetchImpl(`/api/submissions/${encodeURIComponent(submissionId)}`);
      if (!res.ok) return false;
      status = ((await res.json()) as { payoutStatus?: unknown }).payoutStatus;
    } catch {
      // A dropped request says nothing about the payout; ask again.
      continue;
    }
    if (typeof status === "string" && PAID_STATUSES.has(status)) return true;
    if (status !== "pending") return false;
  }
  return false;
}
