"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import TaskCard from "@/components/TaskCard";
import EarningsBadge from "@/components/EarningsBadge";
import WalletChip from "@/components/WalletChip";
import SubmitButton from "@/components/SubmitButton";
import LoadingScreen from "@/components/LoadingScreen";
import AccountSheet from "@/components/AccountSheet";
import InAppLanding from "@/components/InAppLanding";
import LoginScreen from "@/components/LoginScreen";
import AccountAuthScreen from "@/components/AccountAuthScreen";
import WalletClaim from "@/components/WalletClaim";
import PayoutSetup from "@/components/PayoutSetup";
import Toast, { type ToastKind, type ToastMessage } from "@/components/Toast";
import OnboardingScreen from "@/components/OnboardingScreen";
import DisputeForm from "@/components/DisputeForm";
import { identify, track } from "@/lib/analytics";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { isValidStellarAddress } from "@/lib/stellar/signature";

const MIN_LOADING_MS = 1500;

type Screen =
  | "checking"
  | "login"
  | "email_sign_in"
  | "claim_wallet"
  | "payout_setup"
  | "loading"
  | "onboarding"
  | "landing"
  | "task"
  | "no_tasks"
  | "success"
  | "quality_failed"
  | "banned"
  | "cooldown"
  | "wallet_error";

interface TaskData {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  submissionsRemaining?: number | null;
  rewardDisplay?: string;
  rewardSymbol?: string;
}

interface SubmitResponseBody {
  paid?: boolean;
  reason?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
  status?: "pending";
  submissionId?: string;
}

interface BalanceLedgerEntry {
  id: string;
  type: string;
  amount: string;
  amountUnits: string;
  submissionId: string | null;
  note: string | null;
  createdAt: string;
}

const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://stellar.expert/explorer/testnet";

function submitErrorMessage(status: number, code?: string): string {
  switch (code) {
    case "rate_limited":
      return "Please wait a few seconds before submitting again.";
    case "already_submitted":
      return "You've already submitted this task.";
    case "invalid_reason":
      return "Please write a more thoughtful reason (min 10 characters).";
    case "invalid_choice":
      return "Please select Response A or B first.";
    case "invalid_wallet":
      return "Wallet address looks invalid. Please re-link your wallet and try again.";
    case "invalid_task":
      return "Task reference is invalid. Reload and try the next task.";
    case "invalid_body":
      return "Submission couldn't be read. Please try again.";
    case "left_bias_detected":
      return "Please vary your answers — submission rejected.";
    case "repetitive_reason":
      return "Please write a unique, thoughtful reason for each submission.";
    case "task_not_found":
      return "This task is no longer available.";
    case "response_target_reached":
      return "This task has enough submissions. Try the next one.";
    case "payout_failed":
      return "Payment failed. Please try again.";
    case "server_error":
      return "Something went wrong on our end. Please try again.";
  }
  return `Submission failed (${code ?? status}). Please try again.`;
}

/**
 * The contributor app. #30: first connect is one flow — sign in with Freighter
 * (or, for an account created by email, sign in and claim a wallet), set the
 * wallet up for USDC payouts, then onboard. The proven wallet is the account and
 * its payout destination.
 */
export default function Home() {
  const [screen, setScreen] = useState<Screen>("checking");
  const [wallet, setWallet] = useState<string | null>(null);
  const [task, setTask] = useState<TaskData | null>(null);
  const [balance, setBalance] = useState("0");
  const [recentCredits, setRecentCredits] = useState<BalanceLedgerEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [unbannedAt, setUnbannedAt] = useState<string | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState<string>("");
  const [bannedReason, setBannedReason] = useState<string | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [demographics, setDemographics] = useState<{
    country: string | null;
    gender: string | null;
    ageRange: string | null;
  }>({ country: null, gender: null, ageRange: null });

  // Logging out no longer unloads the page, so work that was already in flight
  // can still resolve afterwards. Anything async captures this generation when
  // it starts and drops its result if a logout has bumped it since — otherwise
  // a submission that lands a moment later would move a logged-out tab to the
  // success screen.
  const sessionGeneration = useRef(0);

  const showToast = useCallback((message: string, kind: ToastKind = "info") => {
    setToast({ id: Date.now(), message, kind });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  // ST-5d: identity comes from the session cookie (`labeler_session`), not a
  // `?wallet=` query param. `credentials` are same-origin so the cookie rides
  // along automatically.
  const fetchUserData = useCallback(async () => {
    const generation = sessionGeneration.current;
    const res = await fetch("/api/me");
    // A logged-out /api/me answers 401 with an error body. Applying that would
    // blank the profile rather than leave it alone, so stop at the status.
    if (!res.ok) return null;
    const data = await res.json();
    // A request issued just before a logout can still answer 200; keep its
    // contents off a tab that has since been signed out.
    if (sessionGeneration.current !== generation) return null;
    setSubmissionCount(data.submissionCount ?? 0);
    setOnboardingCompleted(data.onboardingCompleted ?? false);
    setUnbannedAt(data.unbannedAt ?? null);
    setBannedReason(data.bannedReason ?? null);
    setDemographics({
      country: data.country ?? null,
      gender: data.gender ?? null,
      ageRange: data.ageRange ?? null,
    });
    if (data.isCooldown) {
      setScreen("cooldown");
    }
    return data;
  }, []);

  // Accumulate-then-withdraw (P2b): the labeler's earnings now accrue into a
  // session-scoped off-chain balance instead of a per-question on-chain payout.
  // Best-effort: a transient balance fetch failure must not block the flow.
  const fetchBalance = useCallback(async () => {
    const generation = sessionGeneration.current;
    try {
      const res = await fetch("/api/me/balance");
      if (!res.ok) return;
      const data = await res.json();
      if (sessionGeneration.current !== generation) return;
      setBalance(data.pendingBalance ?? "0");
      setRecentCredits(Array.isArray(data.ledger) ? data.ledger : []);
    } catch {
      // ignore — balance display is non-critical
    }
  }, []);

  const fetchTask = useCallback(async () => {
    const res = await fetch("/api/task");
    // #30: an account without a bound wallet is served no work until it claims one.
    if (res.status === 409) {
      setScreen("claim_wallet");
      return;
    }
    const data = await res.json();
    if (data.task) {
      setTask({
        id: data.task.id,
        prompt: data.task.prompt,
        responseA: data.task.responseA,
        responseB: data.task.responseB,
        submissionsRemaining: data.task.submissionsRemaining,
        rewardDisplay: data.task.rewardDisplay,
        rewardSymbol: data.task.rewardSymbol,
      });
      setScreen("task");
      track("task_presented", { task_id: data.task.id });
    } else {
      setScreen("no_tasks");
    }
  }, []);

  /**
   * #30: where a session belongs in first connect. Sign-in, email sign-in and a
   * reload all resolve through here, so a contributor who stopped partway —
   * declined a prompt, closed the tab mid-sponsorship — resumes at that step.
   * A returning wallet that is already set up passes through payout setup
   * without a signature.
   */
  const resolveSession = useCallback(async (): Promise<Screen> => {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return "login";
    const data = (await res.json()) as {
      authenticated?: boolean;
      userId?: string;
      wallet?: string | null;
    };
    if (!data.authenticated) return "login";
    if (data.userId) identify(data.userId);
    // No wallet, or a legacy EVM `0x…` that can never receive USDC: claim one.
    if (!data.wallet || !isValidStellarAddress(data.wallet)) return "claim_wallet";
    setWallet(data.wallet);
    return "payout_setup";
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveSession()
      .catch((): Screen => "login")
      .then((next) => {
        if (!cancelled) setScreen(next);
      });
    return () => {
      cancelled = true;
    };
  }, [resolveSession]);

  // Freighter sign-in and email sign-in set the same `labeler_session` cookie,
  // so both resolve the session the same way.
  const handleSignedIn = useCallback(async () => {
    setScreen("loading");
    try {
      setScreen(await resolveSession());
    } catch {
      setScreen("login");
    }
  }, [resolveSession]);

  const handleWalletClaimed = useCallback((address: string) => {
    setWallet(address);
    setScreen("payout_setup");
  }, []);

  /** Past payout setup, whether it finished or was left for later: onboarding or the landing. */
  const enterApp = useCallback(async () => {
    setScreen("loading");
    try {
      const userData = await fetchUserData();
      await fetchBalance();
      // fetchUserData has already shown the cooldown screen; don't replace it.
      if (userData?.isCooldown) return;
      setScreen(userData?.onboardingCompleted ? "landing" : "onboarding");
    } catch {
      setScreen("wallet_error");
    }
  }, [fetchUserData, fetchBalance]);

  const handlePayoutReady = useCallback(
    async ({ address, sponsored }: { address: string; sponsored: boolean }) => {
      setWallet(address);
      track("payout_ready", { sponsored });
      await enterApp();
    },
    [enterApp],
  );

  // PR #105 review: tasks and submissions need only a bound wallet; payout setup
  // is needed to withdraw. A failure there — Horizon down, the sponsor short of
  // XLM, a legacy account at the sponsorship cap — must not keep a contributor
  // out of the app. A withdrawal refused `payout_setup_required` brings them back.
  const handlePayoutSkipped = useCallback(
    async (reason: string) => {
      track("payout_setup_skipped", { reason });
      await enterApp();
    },
    [enterApp],
  );

  const handlePayoutSetupRequired = useCallback(() => {
    setAccountOpen(false);
    setScreen("payout_setup");
  }, []);

  useEffect(() => {
    if (!unbannedAt || screen !== "cooldown") return;
    const tick = () => {
      const end = new Date(unbannedAt).getTime();
      const now = Date.now();
      const diff = end - now;
      if (diff <= 0) {
        setCooldownRemaining("expired");
        setScreen("landing");
        return;
      }
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setCooldownRemaining(`${hrs}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [unbannedAt, screen]);

  const handleStartEarning = useCallback(() => {
    setScreen("loading");
    fetchTask();
  }, [fetchTask]);

  // Logging out clears the session cookie server-side; everything the signed-in
  // session put in client state has to be dropped here too, or the next labeler
  // to sign in on this tab would flash the previous one's wallet and balance.
  const handleLogout = useCallback(() => {
    sessionGeneration.current += 1;
    setAccountOpen(false);
    setWallet(null);
    setTask(null);
    setBalance("0");
    setRecentCredits([]);
    setSubmissionCount(0);
    setOnboardingCompleted(false);
    setUnbannedAt(null);
    setCooldownRemaining("");
    setBannedReason(null);
    setDisputeOpen(false);
    setDemographics({ country: null, gender: null, ageRange: null });
    setScreen("login");
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingCompleted(true);
    setScreen("landing");
    track("onboarding_completed");
  }, []);

  async function handleSubmit(choice: "A" | "B", reason: string) {
    if (!task) return;
    const generation = sessionGeneration.current;
    const loggedOutSince = () => sessionGeneration.current !== generation;
    setSubmitting(true);
    try {
      let res: Response;
      try {
        res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // ST-5d: identity is the session cookie; the wallet is no longer sent.
          body: JSON.stringify({ taskId: task.id, choice, reason }),
        });
      } catch (err) {
        console.error("[submit] network error", err);
        showToast("Network error. Please check your connection and try again.", "error");
        return;
      }

      let data: SubmitResponseBody = {};
      try {
        data = (await res.json()) as SubmitResponseBody;
      } catch {
        console.error("[submit] non-JSON response", { status: res.status });
      }

      // The answer still counts — the server recorded it — but this tab belongs
      // to nobody now, so none of the outcomes below should reach the screen.
      if (loggedOutSince()) return;

      if (res.status === 409 && data.error === "wallet_required") {
        setScreen("claim_wallet");
        return;
      }

      if (res.status === 403) {
        setScreen("banned");
        track("submission_blocked", { task_id: task.id, reason: "account_banned" });
        return;
      }

      if (!data.paid && data.reason === "quality_check_failed") {
        setScreen("quality_failed");
        track("submission_quality_check_failed", { task_id: task.id });
        setTimeout(() => fetchTask(), 1500);
        return;
      }

      if (data.status === "pending") {
        // The approved answer is credited to the off-chain balance (P2a). Refresh
        // the balance + recent credits instead of polling a per-question payout.
        await fetchUserData();
        await fetchBalance();
        if (loggedOutSince()) return;
        setScreen("success");
        track("submission_approved", {
          task_id: task.id,
          choice,
          credit_status: data.status,
        });
        return;
      }

      console.error("[submit] error response", { status: res.status, error: data.error });
      showToast(submitErrorMessage(res.status, data.error), "error");
    } finally {
      setSubmitting(false);
    }
  }

  let body: React.ReactNode = null;

  if (screen === "checking" || screen === "loading") {
    body = <LoadingScreen />;
  } else if (screen === "login") {
    body = (
      <LoginScreen
        onWalletSignedIn={handleSignedIn}
        onEmailSignIn={() => setScreen("email_sign_in")}
        error={null}
      />
    );
  } else if (screen === "email_sign_in") {
    body = <AccountAuthScreen onBack={() => setScreen("login")} onLoggedIn={handleSignedIn} />;
  } else if (screen === "claim_wallet") {
    body = <WalletClaim onClaimed={handleWalletClaimed} />;
  } else if (screen === "payout_setup") {
    body = <PayoutSetup onReady={handlePayoutReady} onSkip={handlePayoutSkipped} />;
  } else if (screen === "onboarding") {
    body = <OnboardingScreen onComplete={handleOnboardingComplete} />;
  } else if (screen === "landing") {
    body = (
      <InAppLanding
        totalEarned={balance}
        submissionCount={submissionCount}
        onStart={handleStartEarning}
      />
    );
  } else if (screen === "task" && task) {
    body = (
      <div className="min-h-screen bg-surface">
        <header className="sticky top-0 z-40 flex w-full items-center justify-between bg-surface-container-low px-4 py-4">
          <div className="flex items-center gap-2">
            <Image
              src="/logo.png"
              alt=""
              width={32}
              height={32}
              priority
              className="select-none"
            />
            <span className="text-xl font-headline font-extrabold tracking-tighter text-primary">
              Centient
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              aria-label="View account"
              className="rounded-full transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <WalletChip address={wallet} />
            </button>
            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              aria-label="View account"
              className="rounded-full transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <EarningsBadge totalEarned={balance} />
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-lg px-4 py-6">
          <TaskCard task={task} onSubmit={handleSubmit} loading={submitting} reward={task.rewardDisplay} tokenSymbol={task.rewardSymbol} />
        </main>
        <AccountSheet
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          walletAddress={wallet ?? ""}
          totalEarned={balance}
          rewardSymbol={REWARD_TOKEN_SYMBOL}
          submissionCount={submissionCount}
          explorerUrl={EXPLORER_URL}
          country={demographics.country}
          gender={demographics.gender}
          ageRange={demographics.ageRange}
          showToast={showToast}
          onPayoutSetupRequired={handlePayoutSetupRequired}
          onDemographicsDeleted={() =>
            setDemographics({ country: null, gender: null, ageRange: null })
          }
          onLoggedOut={handleLogout}
        />
      </div>
    );
  } else if (screen === "success") {
    body = (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface px-6">
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
          <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
        </div>
        <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container shadow-[0_12px_40px_-12px_rgba(0,109,61,0.5)] motion-safe:animate-[bounce_1s_ease-in-out_1]">
            <span
              className="material-symbols-outlined text-[64px] text-white"
              style={{ fontVariationSettings: "'FILL' 1" }}
              aria-hidden="true"
            >
              check
            </span>
          </div>
          <h2 className="text-2xl font-headline font-bold text-on-surface">
            {`+${task?.rewardDisplay ?? REWARD_AMOUNT} ${task?.rewardSymbol ?? REWARD_TOKEN_SYMBOL} added`}
          </h2>
          <p className="text-center font-body text-sm text-on-surface-variant">
            Your contribution helps improve AI. Earnings build up in your balance —
            withdraw to your wallet anytime.
          </p>
          <div className="w-full rounded-3xl bg-surface-container-lowest p-6 shadow-[0_8px_32px_rgba(25,28,30,0.06)]">
            <div className="flex flex-col items-center">
              <span className="mb-2 font-label text-xs font-bold uppercase tracking-widest text-outline">
                Your balance
              </span>
              <div className="flex items-baseline gap-1">
                <span className="font-headline text-4xl font-extrabold tracking-tighter text-on-surface">
                  {balance}
                </span>
                <span className="font-headline text-xl font-bold text-secondary">{REWARD_TOKEN_SYMBOL}</span>
              </div>
            </div>
            {recentCredits.length > 0 && (
              <div className="mt-5 border-t border-outline-variant/40 pt-4">
                <span className="font-label text-[10px] font-bold uppercase tracking-[0.18em] text-outline">
                  Recent credits
                </span>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {recentCredits.slice(0, 3).map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between font-body text-sm text-on-surface-variant"
                    >
                      <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
                      <span className="font-semibold text-primary">
                        +{entry.amount} {REWARD_TOKEN_SYMBOL}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <SubmitButton label="Next Task" onClick={() => fetchTask()} />
        </div>
      </div>
    );
  } else if (screen === "quality_failed") {
    body = (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-error-container">
            <span
              className="material-symbols-outlined text-[64px] text-on-error-container"
              aria-hidden="true"
            >
              error_outline
            </span>
          </div>
          <h2 className="text-2xl font-headline font-bold text-on-surface">Quality check failed</h2>
          <p className="text-center font-body text-sm text-on-surface-variant">Try another task.</p>
          <SubmitButton label="Next Task" onClick={() => fetchTask()} />
        </div>
      </div>
    );
  } else if (screen === "banned") {
    body = (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-error-container">
            <span
              className="material-symbols-outlined text-[64px] text-on-error-container"
              aria-hidden="true"
            >
              block
            </span>
          </div>
          <h2 className="text-2xl font-headline font-bold text-on-surface">Account paused</h2>
          {bannedReason ? (
            <div className="w-full rounded-2xl bg-surface-container-low px-5 py-4 text-left">
              <span className="font-label text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
                Reason
              </span>
              <p className="mt-1 font-body text-sm text-on-surface">{bannedReason}</p>
            </div>
          ) : (
            <p className="font-body text-sm text-on-surface-variant">
              We noticed unusually low accuracy on recent tasks.
            </p>
          )}
          {!disputeOpen ? (
            <button
              type="button"
              onClick={() => setDisputeOpen(true)}
              className="w-full rounded-xl bg-primary py-3 font-label text-sm font-bold text-on-primary hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              Appeal this decision
            </button>
          ) : (
            <div className="w-full text-left">
              <DisputeForm walletAddress={wallet ?? ""} onDone={() => setDisputeOpen(false)} />
            </div>
          )}
          <a href="mailto:centient@artisam.xyz" className="text-sm text-primary underline">
            centient@artisam.xyz
          </a>
        </div>
      </div>
    );
  } else if (screen === "cooldown") {
    body = (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-error-container">
            <span
              className="material-symbols-outlined text-[64px] text-on-error-container"
              aria-hidden="true"
            >
              timer_pause
            </span>
          </div>
          <h2 className="text-2xl font-headline font-bold text-on-surface">Temporarily paused</h2>
          <p className="font-body text-sm text-on-surface-variant">
            Your account is on cooldown for low accuracy on gold tasks. After the timer
            runs out, you will get a short re-test to restore access.
          </p>
          <div className="rounded-3xl bg-surface-container-low px-8 py-5">
            <div className="font-label text-xs uppercase tracking-[0.18em] text-outline">
              Cooldown ends in
            </div>
            <div className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
              {cooldownRemaining}
            </div>
          </div>
          <a href="mailto:centient@artisam.xyz" className="text-sm text-primary underline">
            centient@artisam.xyz
          </a>
        </div>
      </div>
    );
  } else if (screen === "no_tasks") {
    body = (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-secondary-container">
            <span
              className="material-symbols-outlined text-[48px] text-on-secondary-container"
              aria-hidden="true"
            >
              celebration
            </span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <h2 className="text-2xl font-headline font-bold text-on-surface">
              You&apos;ve done them all
            </h2>
            <p className="font-body text-sm text-on-surface-variant">
              You&apos;ve labelled every task currently in the pool. New tasks land as customers
              upload them — check back in a day or two.
            </p>
          </div>
          <div className="flex flex-col items-center gap-1 rounded-3xl bg-surface-container-low px-6 py-4">
            <span className="font-label text-xs uppercase tracking-[0.18em] text-outline">
              Total earned
            </span>
            <EarningsBadge totalEarned={balance} />
          </div>
        </div>
      </div>
    );
  // ✅ FIX 2: Add explicit handling for wallet_error state
  } else if (screen === "wallet_error") {
    body = (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-error-container">
            <span
              className="material-symbols-outlined text-[64px] text-on-error-container"
              aria-hidden="true"
            >
              link_off
            </span>
          </div>
          <h2 className="text-2xl font-headline font-bold text-on-surface">
            Connection failed
          </h2>
          <p className="font-body text-sm text-on-surface-variant">
            We couldn&apos;t establish a secure session. Please try again.
          </p>
          <SubmitButton label="Try again" onClick={() => window.location.reload()} />
        </div>
      </div>
    );
  }

  return (
    <>
      {body}
      <Toast toast={toast} onDismiss={dismissToast} />
    </>
  );
}
