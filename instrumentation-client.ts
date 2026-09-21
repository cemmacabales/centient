import posthog from "posthog-js";

// Analytics is optional: without a key (tests, fresh worktrees) PostHog stays
// uninitialised and every helper in lib/analytics.ts is a no-op.
const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (key) {
  posthog.init(key, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-01-30",
    // Explicit events only: autocapture records clicked elements' text, which on
    // this app includes wallet addresses and balances.
    autocapture: false,
    // Session replay (toggled in the PostHog project) keeps layout and clicks but
    // masks all text and inputs for the same reason.
    session_recording: { maskAllInputs: true, maskTextSelector: "*" },
  });
}
