import posthog, { type Properties } from "posthog-js";

// Client-side product analytics. PostHog is initialised in instrumentation-client.ts;
// these helpers are no-ops when NEXT_PUBLIC_POSTHOG_KEY is unset.
//
// Never send PII (email, wallet address, demographics) — identify by internal id only.

const enabled = Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);

export function track(event: string, properties?: Properties): void {
  if (enabled) posthog.capture(event, properties);
}

/**
 * Ties this browser's events to an account. Anonymous activity before the first
 * identify is kept; if a different account signs in without logging out first,
 * the identities are split instead of merged.
 */
export function identify(userId: string, properties?: Properties): void {
  if (!enabled) return;
  const current = posthog.get_property("$user_id");
  if (current && current !== userId) posthog.reset();
  posthog.identify(userId, properties);
}

/** Call on logout so the next person on this browser starts anonymous. */
export function resetIdentity(): void {
  if (enabled) posthog.reset();
}
