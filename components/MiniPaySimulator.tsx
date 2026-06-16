"use client";

import { useState } from "react";
import { isSimulationMode, createSimulatedProvider } from "@/lib/simulation";

/**
 * Dev-only: installs a simulated MiniPay wallet on `window.ethereum` so the app
 * behaves as if opened inside MiniPay. Installed during the render phase (via a
 * useState initializer) so it exists before the home page's mount effect runs
 * `isMiniPay()`. Renders nothing. No-op unless `isSimulationMode()`.
 */
export default function MiniPaySimulator() {
  useState(() => {
    if (typeof window === "undefined") return null;
    if (!isSimulationMode()) return null;
    const w = window as unknown as { ethereum?: { __sim?: boolean } };
    if (w.ethereum?.__sim) return null;
    if (w.ethereum) {
      console.warn(
        "[MiniPaySimulator] simulation mode is on — overwriting the existing injected wallet (e.g. MetaMask) for this session.",
      );
    }
    w.ethereum = createSimulatedProvider();
    return null;
  });

  return null;
}
