"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import TaskCard from "@/components/TaskCard";
import EarningsBadge from "@/components/EarningsBadge";
import WalletChip from "@/components/WalletChip";
import SubmitButton from "@/components/SubmitButton";
import LandingSkeleton from "@/components/LandingSkeleton";
import ScreenLoader from "@/components/ScreenLoader";
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
import { sessionStep, type SessionMe } from "@/lib/contributor-session";
import { waitForPayoutToSettle } from "@/lib/payout-settle-watch";
import { GAMIFICATION_ON } from "@/lib/gamification/flag";
import { trackProgress } from "@/lib/gamification/analytics";
import type { Progress, ProgressView } from "@/lib/gamification/types";
import AcceptedStub from "@/components/gamification/AcceptedStub";
import TodayStrip from "@/components/gamification/TodayStrip";
import TierUpScreen from "@/components/gamification/TierUpScreen";
import ProgressScreen, { type ProgressTab } from "@/components/gamification/ProgressScreen";
import { captureCodeFromUrl, clearPendingCode, pendingCode as storedCode } from "@/lib/gamification/event-link";
import { captureInviteFromUrl } from "@/lib/gamification/invite-link";

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
  | "quality_passed"
  | "banned"
  | "cooldown"
  | "wallet_error"
  | "tier_up"
  | "progress";

interface TaskData {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  submissionsRemaining?: number | null;
  rewardDisplay?: string;
  rewardSymbol?: string;
  /** #201: XP the answer earns if accepted; null in retest. */
  xp?: number | null;
  /** #202: the tier whose band holds the task, for its chip. */
  tier?: number;
}

interface SubmitResponseBody {
  paid?: boolean;
  reason?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
  status?: "pending";
  submissionId?: string;
  /** #201: present when the answer earned XP; absent if the XP write failed. */
  progress?: Progress;
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
    case "tier_locked":
      return "This task isn't open at your tier right now. Try the next one.";
    case "payout_check_unavailable":
      return "We couldn't check your wallet can receive USDC. Please try again in a moment.";
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
  // #39: what the contributor has been paid, from /api/me. Answers pay out
  // on-chain as they are accepted, so there is no withdrawable balance to show.
  const [totalEarned, setTotalEarned] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  // #35: a failed submission is announced beside the submit action, not only toasted.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [unbannedAt, setUnbannedAt] = useState<string | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState<string>("");
  const [bannedReason, setBannedReason] = useState<string | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  // #201: the XP loop, behind NEXT_PUBLIC_GAMIFICATION. `progress` is undefined
  // while loading and null when unavailable; `accepted` is the last answer's
  // award, for the success and quality-check screens.
  const [progress, setProgress] = useState<ProgressView | null | undefined>(undefined);
  /** #202: a tier the last answer opened, shown once before the next task. */
  const [pendingTierUp, setPendingTierUp] = useState<number | null>(null);
  const [accepted, setAccepted] = useState<{ progress: Progress; at: Date } | null>(null);
  /** #203: which Progress tab opens, and a booth code waiting to be added. */
  const [progressTab, setProgressTab] = useState<ProgressTab>("stamps");
  const [pendingCode, setPendingCode] = useState<string | null>(null);
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
    setTotalEarned(data.totalEarned ?? "0");
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

  const fetchProgress = useCallback(async () => {
    if (!GAMIFICATION_ON) return;
    const generation = sessionGeneration.current;
    try {
      const res = await fetch("/api/me/progress");
      const data = res.ok ? ((await res.json()) as ProgressView) : null;
      if (sessionGeneration.current === generation) setProgress(data);
    } catch {
      if (sessionGeneration.current === generation) setProgress(null);
    }
  }, []);

  // #203: a booth link's `?code=` waits in this tab through sign-in and
  // onboarding, then opens Progress with the code on the Event code card. An
  // invite link's `?invite=` waits in a cookie for the first wallet sign-in.
  useEffect(() => {
    if (!GAMIFICATION_ON) return;
    captureInviteFromUrl();
    captureCodeFromUrl();
    setPendingCode(storedCode());
  }, []);

  useEffect(() => {
    if (screen === "landing" && pendingCode) {
      setProgressTab("stamps");
      setScreen("progress");
    }
  }, [screen, pendingCode]);

  const settleCode = useCallback(() => {
    clearPendingCode();
    setPendingCode(null);
  }, []);

  // Home and each task show today's goal and the streak as they stand.
  useEffect(() => {
    if (screen === "landing" || screen === "task" || screen === "tier_up" || screen === "progress") void fetchProgress();
  }, [screen, task?.id, fetchProgress]);

  // #39: the sheet shows earnings, which may have risen since the last refresh.
  useEffect(() => {
    if (accountOpen) fetchUserData().catch(() => {});
  }, [accountOpen, fetchUserData]);

  /**
   * Loads the next task for this session onto the ranking surface, clearing the
   * previous task's submit error; with none left, shows no_tasks.
   */
  const fetchTask = useCallback(async () => {
    const res = await fetch("/api/task");
    // #30: an account without a bound wallet is served no work until it claims one.
    if (res.status === 409) {
      setScreen("claim_wallet");
      return;
    }
    const data = await res.json();
    if (data.task) {
      setSubmitError(null);
      setTask({
        id: data.task.id,
        prompt: data.task.prompt,
        responseA: data.task.responseA,
        responseB: data.task.responseB,
        submissionsRemaining: data.task.submissionsRemaining,
        rewardDisplay: data.task.rewardDisplay,
        rewardSymbol: data.task.rewardSymbol,
        xp: data.task.xp ?? null,
        tier: typeof data.task.tier === "number" ? data.task.tier : undefined,
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
    const data = (await res.json()) as SessionMe;
    const next = sessionStep(data);
    if (next.step !== "login" && data.userId) identify(data.userId);
    if (next.step === "payout_setup") setWallet(next.wallet);
    return next.step;
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
      // fetchUserData has already shown the cooldown screen; don't replace it.
      if (userData?.isCooldown) return;
      setScreen(userData?.onboardingCompleted ? "landing" : "onboarding");
    } catch {
      setScreen("wallet_error");
    }
  }, [fetchUserData]);

  const handlePayoutReady = useCallback(
    async ({ address, sponsored }: { address: string; sponsored: boolean }) => {
      setWallet(address);
      track("payout_ready", { sponsored });
      await enterApp();
    },
    [enterApp],
  );

  // PR #105 review: a failure in payout setup — Horizon down, the sponsor short
  // of XLM, a legacy account at the sponsorship cap — must not keep a contributor
  // out of the app. An answer or a withdrawal refused `payout_setup_required`
  // brings them back, since an answer is paid on-chain at once (#37).
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

  /**
   * Logging out clears the session cookie server-side; everything the signed-in
   * session put in client state has to be dropped here too, or the next labeler
   * to sign in on this tab would flash the previous one's wallet and earnings.
   */
  const handleLogout = useCallback(() => {
    sessionGeneration.current += 1;
    setAccountOpen(false);
    setWallet(null);
    setTask(null);
    setSubmitError(null);
    setTotalEarned("0");
    setSubmissionCount(0);
    setOnboardingCompleted(false);
    setUnbannedAt(null);
    setCooldownRemaining("");
    setBannedReason(null);
    setDisputeOpen(false);
    setProgress(undefined);
    setAccepted(null);
    setPendingTierUp(null);
    clearPendingCode();
    setPendingCode(null);
    setDemographics({ country: null, gender: null, ageRange: null });
    setScreen("login");
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingCompleted(true);
    setScreen("landing");
    track("onboarding_completed");
  }, []);

  /**
   * Submits a ranking. Outcomes that leave the task move to their screen; a
   * failure stays on it as `submitError`, which TaskCard announces beside the
   * submit action with the choice and reason kept for a retry.
   */
  /** #201: an answer's XP, for the screen that follows and the next task's strip. */
  function applyProgress(earned: Progress | undefined) {
    setAccepted(earned ? { progress: earned, at: new Date() } : null);
    if (!earned || !GAMIFICATION_ON) return;
    trackProgress(earned);
    if (earned.tier.tierUp !== null) setPendingTierUp(earned.tier.tierUp);
    setProgress((prev) =>
      prev
        ? {
            ...prev,
            xpTotal: earned.xpTotal,
            xpThisWeek: prev.xpThisWeek + earned.xpGained,
            today: { ...prev.today, counted: earned.today.counted, goalMet: earned.today.goalMet },
            streak: {
              days: earned.streak.days,
              best: earned.streak.best,
              restDays: earned.streak.restDays,
              endedAtDays: null,
            },
          }
        : prev,
    );
    if (earned.today.goalJustMet) {
      setToast({
        id: Date.now(),
        kind: "progress",
        // A no-break space keeps "+20 XP" together when the toast wraps on a phone.
        message: `Daily goal met. +${earned.lines.find((l) => l.kind === "DAILY_GOAL")?.amount ?? 20}\u00a0XP`,
        detail: `${earned.streak.days}-day streak`,
      });
    }
  }

  async function handleSubmit(choice: "A" | "B", reason: string) {
    if (!task) return;
    const generation = sessionGeneration.current;
    const loggedOutSince = () => sessionGeneration.current !== generation;
    setSubmitting(true);
    setSubmitError(null);
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
        setSubmitError("Network error. Please check your connection and try again.");
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

      // The wallet can't hold USDC yet, so the answer was not recorded. Payout
      // setup adds the trustline; the task stays unanswered for afterwards.
      if (res.status === 409 && data.error === "payout_setup_required") {
        track("submission_blocked", { task_id: task.id, reason: "payout_setup_required" });
        handlePayoutSetupRequired();
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

      // #37: a passed gold check earns nothing. It was served like any other
      // task, so this is the first the contributor hears it was a quality check.
      if (!data.paid && data.reason === "quality_check_passed") {
        applyProgress(data.progress);
        setScreen("quality_passed");
        track("submission_quality_check_passed", { task_id: task.id });
        return;
      }

      if (data.status === "pending") {
        // #37: the approved answer is queued for an on-chain payout. Refresh the
        // profile; its status is read from the account sheet, not shown here.
        await fetchUserData();
        if (loggedOutSince()) return;
        applyProgress(data.progress);
        setScreen("success");
        // #39: earnings rise only once the worker has paid, after this returns.
        // Refresh them when it has, so the last answer of a session is counted.
        if (typeof data.submissionId === "string") {
          void waitForPayoutToSettle(data.submissionId, { isCancelled: loggedOutSince }).then((paid) => {
            if (paid && !loggedOutSince()) fetchUserData().catch(() => {});
          });
        }
        track("submission_approved", {
          task_id: task.id,
          choice,
          credit_status: data.status,
        });
        return;
      }

      console.error("[submit] error response", { status: res.status, error: data.error });
      setSubmitError(submitErrorMessage(res.status, data.error));
    } finally {
      setSubmitting(false);
    }
  }

  /** After an answer: the tier-up screen first if the answer opened a tier, then the next task. */
  function continueAfterAnswer() {
    if (GAMIFICATION_ON && pendingTierUp !== null) {
      setScreen("tier_up");
      return;
    }
    void fetchTask();
  }

  let body: React.ReactNode = null;

  if (screen === "checking") {
    body = <LandingSkeleton />;
  } else if (screen === "loading") {
    body = <ScreenLoader />;
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
        totalEarned={totalEarned}
        submissionCount={submissionCount}
        onStart={handleStartEarning}
        progress={progress}
        onOpenProgress={(tab = "stamps") => {
          setProgressTab(tab);
          setScreen("progress");
        }}
      />
    );
  } else if (screen === "task" && task) {
    body = (
      <div className="min-h-screen bg-surface">
        <header className="sticky top-0 z-40 w-full bg-surface-container-low">
          <div className={`flex w-full items-center justify-between px-4 ${GAMIFICATION_ON ? "pb-2.5 pt-4" : "py-4"}`}>
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
                <EarningsBadge totalEarned={totalEarned} />
              </button>
            </div>
          </div>
          {GAMIFICATION_ON && progress && (
            <TodayStrip counted={progress.today.counted} streakDays={progress.streak.days} />
          )}
        </header>
        <main className="mx-auto max-w-lg px-4 py-6">
          <TaskCard
            key={task.id}
            task={task}
            onSubmit={handleSubmit}
            loading={submitting}
            error={submitError}
            reward={task.rewardDisplay}
            tokenSymbol={task.rewardSymbol}
            xp={task.xp}
            tier={task.tier}
          />
        </main>
        <AccountSheet
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          walletAddress={wallet ?? ""}
          totalEarned={totalEarned}
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
  } else if (screen === "success" && GAMIFICATION_ON && accepted) {
    // #201 (board 05): the accepted answer as a receipt stub, USDC in gold and
    // XP in indigo. Without a progress block (the XP write failed) the success
    // screen below shows as before.
    const reward = task?.rewardDisplay ?? REWARD_AMOUNT;
    const symbol = task?.rewardSymbol ?? REWARD_TOKEN_SYMBOL;
    body = (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface px-6 py-10">
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
          <div className="absolute -left-[20%] top-[30%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
          <div className="absolute -right-[25%] top-[55%] h-[75vw] w-[75vw] rounded-full bg-tertiary/10 blur-[90px]" />
        </div>
        <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-4">
          <div className="flex h-22 w-22 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-container shadow-[0_12px_40px_-12px_rgba(0,109,61,0.5)] motion-safe:animate-[bounce_1s_ease-in-out_1]">
            <span
              className="material-symbols-outlined text-[44px] text-white"
              style={{ fontVariationSettings: "'FILL' 1" }}
              aria-hidden="true"
            >
              check
            </span>
          </div>
          <div className="flex flex-col items-center gap-1.5 text-center">
            <h2 className="text-2xl font-headline font-bold text-on-surface">
              <span className="font-extrabold text-secondary">{`+${reward} ${symbol}`}</span> on its way
            </h2>
            <p className="font-body text-sm text-on-surface-variant">
              Your contribution helps improve AI. Your reward is being sent to your wallet — follow it in
              your account.
            </p>
          </div>
          <div className="mt-3 w-full">
            <AcceptedStub
              progress={accepted.progress}
              reward={reward}
              symbol={symbol}
              at={accepted.at}
              onSeeStamp={() => {
                setProgressTab("stamps");
                setScreen("progress");
              }}
            />
          </div>
          <div className="w-full pt-4">
            <SubmitButton label="Next Task" onClick={continueAfterAnswer} />
          </div>
        </div>
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
            {`+${task?.rewardDisplay ?? REWARD_AMOUNT} ${task?.rewardSymbol ?? REWARD_TOKEN_SYMBOL} on its way`}
          </h2>
          {/* #37: the reward is queued for an on-chain payout, not yet sent. Say so,
              and point at where it can be followed to sent and confirmed. */}
          <p className="text-center font-body text-sm text-on-surface-variant">
            Your contribution helps improve AI. Your reward is being sent to your wallet —
            follow it in your account.
          </p>
          <SubmitButton label="Next Task" onClick={continueAfterAnswer} />
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
          <SubmitButton label="Next Task" onClick={continueAfterAnswer} />
        </div>
      </div>
    );
  } else if (screen === "quality_passed") {
    const checkXp = accepted?.progress.lines.find((l) => l.kind === "QUALITY_CHECK")?.amount;
    body = (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6">
        <div className="flex w-full max-w-sm flex-col items-center gap-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full bg-secondary-container">
            <span
              className="material-symbols-outlined text-[64px] text-on-secondary-container"
              aria-hidden="true"
            >
              verified
            </span>
          </div>
          <h2 className="text-2xl font-headline font-bold text-on-surface">Quality check passed</h2>
          {GAMIFICATION_ON ? (
            <>
              <p className="text-center font-body text-sm text-on-surface-variant">
                That was a quality-check question. It pays no USDC, but it earns XP and keeps your tier open.
              </p>
              {checkXp !== undefined && (
                <div className="flex w-full items-baseline gap-2 rounded-lg bg-surface-container-lowest px-4 py-3 font-body text-sm leading-5 shadow-[0_4px_12px_rgba(25,28,30,0.04)]">
                  <span className="text-on-surface-variant">XP</span>
                  <span aria-hidden="true" className="flex-1 border-b-2 border-dotted border-outline-variant" />
                  <span className="font-headline font-extrabold tabular-nums text-tertiary">
                    +{checkXp}
                  </span>
                </div>
              )}
            </>
          ) : (
            <p className="text-center font-body text-sm text-on-surface-variant">
              That was a quality-check question. They don&apos;t earn a reward, but passing them keeps your
              account in good standing.
            </p>
          )}
          <SubmitButton label="Next Task" onClick={continueAfterAnswer} />
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
              {GAMIFICATION_ON && " Today won't break your streak."}
            </p>
          </div>
          <div className="flex flex-col items-center gap-1 rounded-3xl bg-surface-container-low px-6 py-4">
            <span className="font-label text-xs uppercase tracking-[0.18em] text-outline">
              Total earned
            </span>
            <EarningsBadge totalEarned={totalEarned} />
          </div>
        </div>
      </div>
    );
  } else if (screen === "tier_up" && pendingTierUp !== null) {
    body = (
      <TierUpScreen
        tierUp={pendingTierUp}
        summary={progress === undefined ? undefined : (progress?.tier ?? null)}
        onSeeTasks={() => {
          setPendingTierUp(null);
          void fetchTask();
        }}
        onHome={() => {
          setPendingTierUp(null);
          setScreen("landing");
        }}
      />
    );
  } else if (screen === "progress") {
    body = (
      <ProgressScreen
        key={progressTab}
        progress={progress}
        initialTab={progressTab}
        pendingCode={pendingCode}
        onRedeemed={() => {
          settleCode();
          void fetchProgress();
        }}
        onBack={() => {
          // Seen and left: the link's code doesn't reopen Progress again.
          settleCode();
          setScreen("landing");
        }}
      />
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
