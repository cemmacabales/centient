import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  allowedDevOrigins: [
    "impromptu-effective-qualify.ngrok-free.dev",
    "*.ngrok-free.dev",
    "*.ngrok-free.app",
  ],
};

export default config;