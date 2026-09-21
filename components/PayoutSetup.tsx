"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signTransaction } from "@/lib/stellar/wallet";
import {
  PAYOUT_SETUP_MESSAGES,
  PAYOUT_SIGNING_NOTICE,
  payoutWaitingNotice,
  setUpPayouts,
  type PayoutSetupFailure,
  type PayoutSetupResult,
  type SponsorshipEnvelopeKind,
} from "@/lib/stellar/payout-setup";

export type PayoutSetupPhase = "working" | "signing" | "waiting" | "failed";

interface PayoutSetupViewProps {
  phase: PayoutSetupPhase;
  /** Set when `phase` is "signing". */
  signingKind?: SponsorshipEnvelopeKind;
  /** Set when `phase` is "waiting". */
  waitSeconds?: number;
  /** Set when `phase` is "failed". */
  reason?: PayoutSetupFailure;
  onRetry: () => void;
  /** Leave setup for later and go on into the app. Offered on failure when set. */
  onContinue?: () => void;
}

/**
 * The payout-setup step for one state (#30). Stateless, so every state can be
 * rendered and tested on its own. A declined prompt reads as guidance, not an
 * error: nothing was submitted. A failure never traps the contributor: setup is
 * only needed to withdraw, so they can carry on and finish it later.
 */
export function PayoutSetupView({
  phase,
  signingKind,
  waitSeconds,
  reason,
  onRetry,
  onContinue,
}: PayoutSetupViewProps) {
  const failure = phase === "failed" ? (reason ?? "failed") : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-secondary-container">
          <span className="material-symbols-outlined text-[48px] text-on-secondary-container" aria-hidden="true">
            account_balance_wallet
          </span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-2xl font-headline font-bold text-on-surface">Setting up USDC payouts</h2>
          <p className="font-body text-sm text-on-surface-variant">
            Your wallet address is where your earnings are paid. Centient covers the network fee and
            reserves — you need no XLM.
          </p>
        </div>

        <div role="status" aria-live="polite" aria-busy={phase !== "failed"} className="w-full">
          {phase === "working" && (
            <p className="font-body text-sm text-on-surface-variant">Checking your wallet…</p>
          )}
          {phase === "signing" && (
            <p data-signing={signingKind} className="font-body text-sm text-on-surface-variant">
              {PAYOUT_SIGNING_NOTICE[signingKind ?? "account+trustline"]}
            </p>
          )}
          {phase === "waiting" && (
            <p data-waiting={waitSeconds} className="font-body text-sm text-on-surface-variant">
              {payoutWaitingNotice(waitSeconds ?? 0)}
            </p>
          )}
          {failure && (
            <p
              data-failure={failure}
              className={`font-body text-sm ${failure === "rejected" ? "text-on-surface-variant" : "text-error"}`}
            >
              {PAYOUT_SETUP_MESSAGES[failure]}
            </p>
          )}
        </div>

        {failure && (
          <div className="flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={onRetry}
              className="flex h-14 w-full items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              Try again
            </button>
            {onContinue && (
              <button
                type="button"
                onClick={onContinue}
                className="w-full rounded-full py-3 font-label text-base font-semibold text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Continue for now
              </button>
            )}
            {onContinue && (
              <p className="font-body text-xs text-on-surface-variant">
                You can keep earning. Finish payout setup before you withdraw.
              </p>
            )}
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="w-full rounded-xl py-2 font-label text-sm font-semibold text-on-surface-variant underline-offset-2 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

interface SetupProgress {
  onSigning: (kind: SponsorshipEnvelopeKind | null) => void;
  onWaiting: (seconds: number | null) => void;
}

type RunSetup = (progress: SetupProgress) => Promise<PayoutSetupResult>;

const runSetUpPayouts: RunSetup = ({ onSigning, onWaiting }) =>
  setUpPayouts({ signTransaction, fetch: (...args) => fetch(...args), onSigning, onWaiting });

interface PayoutSetupProps {
  /** Called once the bound wallet can receive USDC. */
  onReady: (result: { address: string; sponsored: boolean }) => void;
  /** Called when the contributor leaves a failed setup for later, with the failure. */
  onSkip?: (reason: PayoutSetupFailure) => void;
  /** Injectable for tests; defaults to the real Freighter + API flow. */
  run?: RunSetup;
}

/**
 * Make the session's bound wallet payout-ready, starting on mount. A returning
 * wallet that is already set up passes straight through without a signature.
 */
export default function PayoutSetup({ onReady, onSkip, run = runSetUpPayouts }: PayoutSetupProps) {
  const [phase, setPhase] = useState<PayoutSetupPhase>("working");
  const [signingKind, setSigningKind] = useState<SponsorshipEnvelopeKind | undefined>();
  const [waitSeconds, setWaitSeconds] = useState<number | undefined>();
  const [reason, setReason] = useState<PayoutSetupFailure | undefined>();
  const inFlight = useRef(false);
  // Held in a ref so a parent re-render with a new callback never restarts setup.
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  /** Run one setup attempt; ignores a second start while one is in flight. */
  const attempt = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("working");
    setReason(undefined);
    const result = await run({
      onSigning: (kind) => {
        setSigningKind(kind ?? undefined);
        setPhase(kind ? "signing" : "working");
      },
      onWaiting: (seconds) => {
        setWaitSeconds(seconds ?? undefined);
        setPhase(seconds ? "waiting" : "working");
      },
    });
    inFlight.current = false;
    if (result.ok) {
      onReadyRef.current({ address: result.address, sponsored: result.sponsored });
      return;
    }
    setReason(result.reason);
    setPhase("failed");
  }, [run]);

  useEffect(() => {
    void attempt();
  }, [attempt]);

  return (
    <PayoutSetupView
      phase={phase}
      signingKind={signingKind}
      waitSeconds={waitSeconds}
      reason={reason}
      onRetry={attempt}
      onContinue={onSkip ? () => onSkip(reason ?? "failed") : undefined}
    />
  );
}
