"use client";

import { useEffect, useRef } from "react";
import posthog from "posthog-js";

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  const initialized = useRef(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (key && !initialized.current) {
      posthog.init(key, {
        api_host: "https://us.i.posthog.com",
        capture_pageview: false,
        autocapture: false,
      });
      initialized.current = true;
    }
  }, []);

  return <>{children}</>;
}

export { posthog };
