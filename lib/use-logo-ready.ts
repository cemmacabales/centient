"use client";

import { useCallback, useState } from "react";

/**
 * Whether a logo can paint yet, for holding back the text beside it. The text
 * is in the HTML while the logo is a separate request, so left alone the text
 * shows first and the logo pops in next to it. Spread `imageProps` onto the
 * `next/image` logo.
 */
export function useLogoReady() {
  const [ready, setReady] = useState(false);
  // Settles on an error too: a logo that never arrives must not hide the brand.
  const settle = useCallback(() => setReady(true), []);
  // A logo already in memory (the landing skeleton preloads the landing
  // header's) is complete as it mounts. Settling in the ref, before the first
  // paint, saves the frame `onLoad` spends waiting on `decode()`.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setReady(true);
  }, []);
  return {
    ready,
    // `decoding="sync"` keeps the paint that reveals the text from going out
    // without the logo in it.
    imageProps: { ref, onLoad: settle, onError: settle, decoding: "sync" as const },
  };
}
