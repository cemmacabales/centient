import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// PostHog is reached through the same-origin `/ingest` rewrite below, so the
// CSP needs no PostHog hosts; `worker-src blob:` is for session replay's worker.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.sentry.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://*.sentry.io",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  allowedDevOrigins: [
    "impromptu-effective-qualify.ngrok-free.dev",
    "*.ngrok-free.dev",
    "*.ngrok-free.app",
  ],
  /** Security headers on every route; the CSP only lets the app frame itself. */
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
        ],
      },
    ];
  },
  /** First-party proxy for PostHog (US cloud): keeps the CSP closed and survives ad blockers. */
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
  // PostHog's API paths end in a slash; Next's redirect would break the proxied POSTs.
  skipTrailingSlashRedirect: true,
};

export default withSentryConfig(config, {
  silent: true,
  telemetry: false,
  widenClientFileUpload: true,
});
