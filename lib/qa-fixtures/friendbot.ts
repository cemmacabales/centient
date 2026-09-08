// Testnet XLM funding, shared by both QA provisioning scripts.
//
// Extracted because the two had diverged: the recipient provisioner retried and
// treated "already funded" as success, while the sponsor minter threw on the
// first non-OK response. That second behaviour turns a transient friendbot blip
// — or an account friendbot had already funded — into a failed fixture run, and
// in the sponsor's case it fails *before* the sponsorship, which is the half that
// costs something to redo.
const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** Friendbot's answer when the account already exists. Success, for our purposes. */
const ALREADY_FUNDED = "createAccountAlreadyExist";

export interface FriendbotOptions {
  attempts?: number;
  /** Base backoff; attempt N waits `backoffMs * N`. */
  backoffMs?: number;
  /** Per-attempt ceiling. Node's fetch has no default, so without this a stalled
   *  request hangs forever and the retry below never gets to run. */
  timeoutMs?: number;
  onRetry?: (message: string) => void;
}

/**
 * Fund a testnet account, tolerating the two failures that are not failures:
 * an account friendbot has already created, and a transient error worth retrying.
 */
export async function friendbotFund(
  publicKey: string,
  { attempts = 4, backoffMs = 2000, timeoutMs = 30_000, onRetry }: FriendbotOptions = {},
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status: number;
    let body: string;

    try {
      const response = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`, {
        // A stalled attempt aborts into the catch below and stays retryable,
        // rather than holding the whole run open indefinitely.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      status = response.status;
      body = await response.text();
    } catch (error) {
      // A network-level failure is as retryable as a 5xx, and throwing here
      // would defeat the retry the caller asked for.
      status = 0;
      body = (error as Error).message;
    }

    if (status === 400 && body.includes(ALREADY_FUNDED)) {
      onRetry?.(`${publicKey.slice(0, 8)}… already funded`);
      return;
    }

    if (attempt === attempts) {
      throw new Error(
        `friendbot funding failed for ${publicKey} after ${attempts} attempts ` +
          `(HTTP ${status}): ${body.slice(0, 200)}`,
      );
    }

    onRetry?.(`friendbot attempt ${attempt} failed (HTTP ${status}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
  }
}
