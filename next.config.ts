import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  allowedDevOrigins: [
    "impromptu-effective-qualify.ngrok-free.dev",
    "*.ngrok-free.dev",
    "*.ngrok-free.app",
  ],
};

export default withSentryConfig(config, {
  silent: true,
  telemetry: false,
  widenClientFileUpload: true,
});