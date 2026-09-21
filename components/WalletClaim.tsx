"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";
import {
  WALLET_CLAIM_MESSAGES,
  claimWallet,
  type WalletClaimFailure,
  type WalletClaimResult,
} from "@/lib/stellar/wallet-claim";

const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";

export type WalletClaimPhase = "idle" | "connecting" | "failed";

interface WalletClaimViewProps {
  phase: WalletClaimPhase;
  /** Set when `phase` is "failed". */
  reason?: WalletClaimFailure;
  onConnect: () => void;
}

/**
 * The claim step for an account created by email (#30), for one state.
 * Stateless, so every state can be rendered and tested on its own.
 */
export function WalletClaimView({ phase, reason, onConnect }: WalletClaimViewProps) {
  const connecting = phase === "connecting";
  const failure = phase === "failed" ? (reason ?? "failed") : null;
  const label = connecting ? "Waiting for Freighter…" : failure ? "Try again" : "Connect Freighter";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-secondary-container">
          <span className="material-symbols-outlined text-[48px] text-on-secondary-container" aria-hidden="true">
            link
          </span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-2xl font-headline font-bold text-on-surface">Connect your wallet to keep earning</h2>
          <p className="font-body text-sm text-on-surface-variant">
            Centient now pays to a Stellar wallet you prove is yours. Connect Freighter once: your balance
            stays with this account, and from then on you sign in with the wallet — no email or password.
          </p>
        </div>

        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          aria-busy={connecting}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-60"
        >
          <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
            account_balance_wallet
          </span>
          {label}
        </button>

        <div role="status" aria-live="polite" className="w-full">
          {failure && (
            <p
              data-failure={failure}
              className={`font-body text-sm ${failure === "rejected" ? "text-on-surface-variant" : "text-error"}`}
            >
              {WALLET_CLAIM_MESSAGES[failure]}
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

        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="font-label text-sm font-semibold text-on-surface-variant underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

interface WalletClaimProps {
  /** Called once the proven address is bound to the signed-in account. */
  onClaimed: (address: string) => void;
  /** Injectable for tests; defaults to the real Freighter + API flow. */
  claim?: () => Promise<WalletClaimResult>;
}

/** Connect Freighter and bind its address to the email account that is signed in. */
export default function WalletClaim({ onClaimed, claim = claimWallet }: WalletClaimProps) {
  const [phase, setPhase] = useState<WalletClaimPhase>("idle");
  const [reason, setReason] = useState<WalletClaimFailure | undefined>();

  /** Run one claim attempt; ignores clicks while one is already in flight. */
  const handleConnect = async () => {
    if (phase === "connecting") return;
    setPhase("connecting");
    setReason(undefined);
    const result = await claim();
    if (result.ok) {
      onClaimed(result.address);
      return;
    }
    track("wallet_connect_failed", { flow: "claim", reason: result.reason });
    setReason(result.reason);
    setPhase("failed");
  };

  return <WalletClaimView phase={phase} reason={reason} onConnect={handleConnect} />;
}
