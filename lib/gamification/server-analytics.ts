import { PostHog } from "posthog-node";
import { TIERS } from "./tiers";

// #202: tier and stamp events are sent from the server, at the one write that
// changes them, so each fires once wherever it happened: a hold or a stamp can
// come from the payout worker, which no browser sees. The distinct id is the
// internal user id, the same one the browser identifies with (lib/analytics.ts),
// so these land on the labeler's person. No wallet, no task text.

let _client: PostHog | null | undefined;

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

export interface StandingChange {
  tier: number;
  tierUp: number | null;
  heldNow: boolean;
  reopened: boolean;
  stampsAwarded: string[];
}

/** Send `tier_up`, `tier_on_hold` and `stamp_awarded` for one change. Never throws. */
export function captureStanding(userId: string, change: StandingChange): void {
  if (change.tierUp !== null) captureServer(userId, "tier_up", { tier: change.tierUp, tier_name: TIERS[change.tierUp].name });
  if (change.heldNow) captureServer(userId, "tier_on_hold", { tier: change.tier, tier_name: TIERS[change.tier].name });
  for (const stamp of change.stampsAwarded) captureServer(userId, "stamp_awarded", { stamp });
}

/**
 * #203: one server event on the labeler's person, for writes no browser sees
 * through to the end (a code redeemed, a name set, a week's board closing).
 * Never throws.
 */
export function captureServer(userId: string, event: string, properties: Record<string, unknown> = {}): void {
  try {
    client()?.capture({ distinctId: userId, event, properties });
  } catch {
    // Analytics is best-effort; the change already stands.
  }
}
