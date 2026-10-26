"use client";

import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import CancelWalletWait from "./CancelWalletWait";
import FreighterPairing from "./FreighterPairing";
import LanternButton from "./LanternButton";
import { cancelWalletRequest, prepareWallet, type WalletTransport } from "@/lib/stellar/wallet";
import { isLanternInstalled, lanternOpenUrl, walletCopy } from "@/lib/stellar/lantern";
import {
  WALLET_SIGN_IN_MESSAGES,
  signInWithWallet,
  type WalletSignInFailure,
  type WalletSignInResult,
} from "@/lib/stellar/wallet-sign-in";

const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";

export type WalletSignInPhase = "idle" | "connecting" | "failed";

interface WalletSignInViewProps {
  phase: WalletSignInPhase;
  /** Set when `phase` is "failed". */
  reason?: WalletSignInFailure;
  /** Which Freighter this browser will reach; null until resolved. */
  transport?: WalletTransport | null;
  onConnect: () => void;
  /** Stop waiting on the Freighter app. Shown only while waiting on it. */
  onCancel?: () => void;
  /**
   * Set on an Android phone that has Lantern: the link that reopens this page
   * inside it. The Lantern button then leads, and Freighter is one tap behind.
   */
  lanternHref?: string | null;
  /** Put Freighter back in front of a Lantern offer. */
  onUseFreighter?: () => void;
}

/**
 * The Freighter sign-in control for one state. Stateless, so every state can be
 * rendered and tested on its own.
 *
 * A declined prompt is shown as neutral guidance, not an error: nothing went
 * wrong, and #24 found a rejection uses nothing up server-side.
 *
 * The label follows the transport, because the two are different acts: the
 * extension opens a prompt in this browser, while the mobile app has to be
 * opened. Promising the wrong one is how a contributor on a phone ends up
 * waiting on a window that is never going to appear.
 */
export function WalletSignInView({
  phase,
  reason,
  transport,
  onConnect,
  onCancel,
  lanternHref,
  onUseFreighter,
}: WalletSignInViewProps) {
  const connecting = phase === "connecting";
  const failure = phase === "failed" ? (reason ?? "failed") : null;
  const mobile = transport === "walletconnect";
  const inLantern = transport === "lantern";
  const label = connecting
    ? mobile
      ? "Waiting for the Freighter app…"
      : inLantern
        ? "Waiting for Lantern…"
        : "Waiting for Freighter…"
    : failure
      ? "Try again"
      : mobile
        ? "Open Freighter app"
        : inLantern
          ? "Connect Lantern"
          : "Connect Freighter";

  // An Android phone with Lantern: offer the wallet it already has. Nothing has
  // been attempted on this page yet, so there is no state to show beside it.
  if (lanternHref && !inLantern && phase === "idle") {
    return (
      <div className="flex w-full flex-col items-center gap-3 sm:max-w-xs">
        <LanternButton href={lanternHref}>Open in Lantern</LanternButton>
        <button
          type="button"
          onClick={onUseFreighter}
          className="font-label text-sm font-semibold text-on-surface-variant underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          Use Freighter instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-3 sm:max-w-xs">
      {inLantern ? (
        <LanternButton onClick={onConnect} disabled={connecting} busy={connecting}>
          {label}
        </LanternButton>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          aria-busy={connecting}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-[translate,scale,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_rgba(0,109,61,0.3)] active:translate-y-0 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60 disabled:hover:translate-y-0"
        >
          <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
            account_balance_wallet
          </span>
          {label}
        </button>
      )}

      {connecting && (mobile || inLantern) && onCancel && <CancelWalletWait onCancel={onCancel} />}

      <div role="status" aria-live="polite" className="w-full text-center">
        {failure && (
          <p
            data-failure={failure}
            className={`font-body text-sm ${
              failure === "rejected" || failure === "cancelled" ? "text-on-surface-variant" : "text-error"
            }`}
          >
            {walletCopy(WALLET_SIGN_IN_MESSAGES[failure], transport)}
          </p>
        )}
        {failure === "freighter_missing" && (
          <a
            href={FREIGHTER_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block font-label text-sm font-semibold text-primary underline-offset-2 hover:underline"
          >
            Get Freighter
          </a>
        )}
      </div>
    </div>
  );
}

interface WalletSignInProps {
  /** Called once the session cookie is set. */
  onSignedIn: (result: { address: string; created: boolean }) => void;
  /** Injectable for tests; defaults to the real Freighter + API flow. */
  signIn?: () => Promise<WalletSignInResult>;
  /**
   * Mount the mobile-app pairing prompt. The prompt listens for any pairing on
   * the page, so a page with two sign-in buttons mounts it once.
   */
  pairing?: boolean;
}

/** Freighter sign-in: connect, sign the one-time challenge, get a session. */
export default function WalletSignIn({ onSignedIn, signIn = signInWithWallet, pairing = true }: WalletSignInProps) {
  const [phase, setPhase] = useState<WalletSignInPhase>("idle");
  const [reason, setReason] = useState<WalletSignInFailure | undefined>();
  const [transport, setTransport] = useState<WalletTransport | null>(null);
  const [lanternHref, setLanternHref] = useState<string | null>(null);

  // Resolved on mount so the button reads correctly before it is pressed —
  // extension detection needs `window`, so it can't happen during render — and
  // so the mobile path's slow parts (relay SDK, deep-link lookup) happen while
  // the contributor is still reading, not between their tap and the app.
  useEffect(() => {
    let live = true;
    void prepareWallet().then((t) => {
      if (live) setTransport(t);
    });
    // Android only, and only once Chrome confirms Lantern is installed; until
    // then (and everywhere else) the Freighter button stands as it always has.
    void isLanternInstalled().then((installed) => {
      if (live && installed) setLanternHref(lanternOpenUrl(window.location.href));
    });
    return () => {
      live = false;
    };
  }, []);

  /** Run one sign-in attempt; ignores clicks while one is already in flight. */
  const handleConnect = async () => {
    if (phase === "connecting") return;
    setPhase("connecting");
    setReason(undefined);
    const result = await signIn();
    if (result.ok) {
      onSignedIn({ address: result.address, created: result.created });
      return;
    }
    track("wallet_connect_failed", { flow: "sign_in", reason: result.reason });
    setReason(result.reason);
    setPhase("failed");
  };

  return (
    <>
      <WalletSignInView
        phase={phase}
        reason={reason}
        transport={transport}
        onConnect={handleConnect}
        onCancel={() => void cancelWalletRequest()}
        lanternHref={lanternHref}
        onUseFreighter={() => setLanternHref(null)}
      />
      {pairing && <FreighterPairing />}
    </>
  );
}
