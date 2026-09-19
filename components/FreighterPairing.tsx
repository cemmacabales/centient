"use client";

import { useCallback, useEffect, useState } from "react";
import {
  isFreighterInAppBrowser,
  isMobileBrowser,
  onPairing,
  type WalletConnectPairing,
} from "@/lib/stellar/wallet-connect";

/**
 * The prompt that hands a WalletConnect pairing to the Freighter **mobile**
 * app, shown while `connect()` waits for the user to approve.
 *
 * It renders nothing until the transport publishes a pairing, so mounting it
 * next to a connect button costs nothing on the desktop-extension path, which
 * never pairs at all.
 *
 * Two shapes, because the user is in one of two places:
 *
 *   • **on the phone that holds the wallet** — we can hand the pairing straight
 *     to the app, so the whole screen is one "Open Freighter" button and the
 *     first one is taken automatically;
 *   • **on a desktop with no extension** — the wallet is on a different device,
 *     so the pairing has to travel as a QR code for the app to scan.
 *
 * The deep link is resolved from the WalletConnect registry by the transport
 * and may legitimately be absent; the QR is always available, so that is what
 * this falls back to rather than stranding the user.
 */

const FREIGHTER_DOWNLOAD_URL = "https://www.freighter.app/";

interface FreighterPairingViewProps {
  pairing: WalletConnectPairing;
  /** True on the device that would hold the wallet. */
  onWalletDevice: boolean;
  qrSvg: string | null;
  copied: boolean;
  onCopy: () => void;
  onOpenApp: () => void;
}

/** One pairing state, stateless so every state can be rendered and tested alone. */
export function FreighterPairingView({
  pairing,
  onWalletDevice,
  qrSvg,
  copied,
  onCopy,
  onOpenApp,
}: FreighterPairingViewProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect the Freighter mobile app"
      data-pairing={onWalletDevice ? "mobile" : "desktop"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-6 text-center shadow-[0_24px_48px_rgba(25,28,30,0.24)]">
        <h2 className="font-headline text-xl font-bold text-on-surface">
          {onWalletDevice ? "Approve in Freighter" : "Scan with Freighter"}
        </h2>
        <p className="font-body text-sm text-on-surface-variant">
          {onWalletDevice
            ? "Freighter should open so you can approve the connection. Come back here once you have."
            : "Open the Freighter app on your phone and scan this code to connect."}
        </p>

        {onWalletDevice ? (
          <>
            {pairing.deepLink ? (
              <button
                type="button"
                onClick={onOpenApp}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
                  open_in_new
                </span>
                Open Freighter
              </button>
            ) : (
              /* The registry lookup didn't answer, so we can't link into the
                 app. Copying the pairing into Freighter's own connect screen
                 still works, and the QR below covers a second device. */
              <p className="font-body text-sm text-on-surface-variant">
                Copy the pairing link below, then paste it into Freighter.
              </p>
            )}
          </>
        ) : (
          /* The SVG is generated locally by `qrcode` from the `wc:` URI we just
             produced — no third-party markup ever reaches this. */
          qrSvg ? (
            <div
              aria-hidden="true"
              data-qr="ready"
              className="h-[232px] w-[232px] rounded-xl bg-white p-3 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <div
              data-qr="pending"
              className="flex h-[232px] w-[232px] items-center justify-center rounded-xl bg-surface-container"
            >
              <span className="font-body text-sm text-on-surface-variant">
                Preparing code…
              </span>
            </div>
          )
        )}

        <button
          type="button"
          onClick={onCopy}
          className="font-label text-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {copied ? "Pairing link copied" : "Copy pairing link"}
        </button>

        <a
          href={FREIGHTER_DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-label text-sm font-semibold text-on-surface-variant underline-offset-2 hover:underline"
        >
          Don&apos;t have Freighter yet?
        </a>
      </div>
    </div>
  );
}

/** Live pairing prompt: subscribes to the transport and renders the current one. */
export default function FreighterPairing() {
  const [pairing, setPairing] = useState<WalletConnectPairing | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Resolved once on the client: `isMobileBrowser` reads `navigator`, so
  // deciding during render would disagree with the server-rendered markup.
  const [onWalletDevice, setOnWalletDevice] = useState(false);

  useEffect(() => onPairing(setPairing), []);

  useEffect(() => {
    setOnWalletDevice(isMobileBrowser() || isFreighterInAppBrowser());
  }, []);

  // A fresh pairing supersedes whatever was on screen.
  useEffect(() => setCopied(false), [pairing?.uri]);

  // Render the QR only where it is shown, so the phone path never pays for it.
  useEffect(() => {
    if (!pairing || onWalletDevice) {
      setQrSvg(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const { toString: toQrString } = await import("qrcode");
        const svg = await toQrString(pairing.uri, {
          type: "svg",
          margin: 0,
          errorCorrectionLevel: "M",
        });
        if (live) setQrSvg(svg);
      } catch {
        if (live) setQrSvg(null); // the copy link still gets the user through
      }
    })();
    return () => {
      live = false;
    };
  }, [pairing, onWalletDevice]);

  const openApp = useCallback(() => {
    if (pairing?.deepLink) window.location.href = pairing.deepLink;
  }, [pairing?.deepLink]);

  // Take the first hand-off automatically: on the wallet's own device, being
  // dropped into Freighter is the whole point, and an extra tap between the
  // button that was just pressed and the app is friction with no purpose.
  useEffect(() => {
    if (onWalletDevice && pairing?.deepLink) openApp();
    // `openApp` is memoized on the link, so this fires once per *new* pairing
    // rather than on every render — which would yank the user out of the
    // browser again each time this component re-renders.
  }, [pairing?.deepLink, onWalletDevice, openApp]);

  const copy = useCallback(() => {
    if (!pairing) return;
    void navigator.clipboard?.writeText(pairing.uri).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [pairing]);

  if (!pairing) return null;

  return (
    <FreighterPairingView
      pairing={pairing}
      onWalletDevice={onWalletDevice}
      qrSvg={qrSvg}
      copied={copied}
      onCopy={copy}
      onOpenApp={openApp}
    />
  );
}
