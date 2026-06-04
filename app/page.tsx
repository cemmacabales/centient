"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { isMiniPay, connectMiniPay } from "@/lib/minipay";
import TaskCard from "@/components/TaskCard";
import EarningsBadge from "@/components/EarningsBadge";
import WalletChip from "@/components/WalletChip";
import SubmitButton from "@/components/SubmitButton";
import LoadingScreen from "@/components/LoadingScreen";
import AccountSheet from "@/components/AccountSheet";
import InAppLanding from "@/components/InAppLanding";
import OutsideMiniPayPage from "@/components/OutsideMiniPayPage";
import Toast, { type ToastKind, type ToastMessage } from "@/components/Toast";
import OnboardingScreen from "@/components/OnboardingScreen";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

const MIN_LOADING_MS = 1500;

type Screen =
  | "checking"
  | "not_minipay"
  | "loading"
  | "onboarding"
  | "landing"
  | "task"
  | "no_tasks"
  | "success"
  | "quality_failed"
  | "banned"
  | "wallet_error";

interface TaskData {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
  rewardDisplay?: string;
  rewardSymbol?: string;
}

interface SubmitResponseBody {
  paid?: boolean;
  reason?: string;
  txHash?: string;
  error?: string;
}

const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://celoscan.io";

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
      return "Wallet address looks invalid. Reopen the app from MiniPay.";
    case "invalid_task":
      return "Task reference is invalid. Reload and try the next task.";
    case "invalid_body":
      return "Submission couldn't be read. Please try again.";
    case "left_bias_detected":
      return "Please vary your answers — submission rejected.";
    case "task_not_found":
      return "This task is no longer available.";
    case "payout_failed":
      return "Payment failed. Please try again.";
    case "server_error":
      return "Something went wrong on our end. Please try again.";
  }
  return `Submission failed (${code ?? status}). Please try again.`;
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("checking");
  const [wallet, setWallet] = useState<string | null>(null);
  const [task, setTask] = useState<TaskData | null>(null);
  const [earnings, setEarnings] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);

  const showToast = useCallback((message: string, kind: ToastKind = "info") => {
    setToast({ id: Date.now(), message, kind });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const fetchUserData = useCallback(async (addr: string) => {
    const res = await fetch(`/api/me?wallet=${addr}`);
    const data = await res.json();
    setEarnings(data.totalEarned ?? "0");
    setSubmissionCount(data.submissionCount ?? 0);
    setOnboardingCompleted(data.onboardingCompleted ?? false);
    return data;
  }, []);

  const fetchTask = useCallback(async (addr: string) => {
    const res = await fetch(`/api/task?wallet=${addr}`);
    const data = await res.json();
    if (data.task) {
      setTask({
        id: data.task.id,
        prompt: data.task.prompt,
        responseA: data.task.responseA,
        responseB: data.task.responseB,
        rewardDisplay: data.task.rewardDisplay,
        rewardSymbol: data.task.rewardSymbol,
      });
      setScreen("task");
    } else {
      setScreen("no_tasks");
    }
  }, []);

  useEffect(() => {
    if (!isMiniPay()) {
      setScreen("not_minipay");
      return;
    }
    setScreen("loading");
    const connect = connectMiniPay().then(async (addr) => {
      setWallet(addr);
      const userData = await fetchUserData(addr);
      return userData;
    });
    const minDelay = new Promise<void>((resolve) => setTimeout(resolve, MIN_LOADING_MS));
    Promise.all([connect, minDelay])
      .then(([userData]) => {
        if (userData?.onboardingCompleted) {
          setScreen("landing");
        } else {
          setScreen("onboarding");
        }
      })
      .catch(() => setScreen("wallet_error"));
  }, [fetchUserData]);

  const handleStartEarning = useCallback(() => {
    if (!wallet) return;
    setScreen("loading");
    fetchTask(wallet);
  }, [wallet, fetchTask]);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingCompleted(true);
    setScreen("landing");
  }, []);

  async function handleSubmit(choice: "A" | "B", reason: string) {
    if (!wallet || !task) return;
    setSubmitting(true);
    try {
      let res: Response;
      try {
        res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: wallet, taskId: task.id, choice, reason }),
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

      if (res.status === 403) {
        setScreen("banned");
        return;
      }

      if (!data.paid && data.reason === "quality_check_failed") {
        setScreen("quality_failed");
        setTimeout(() => fetchTask(wallet), 1500);
        return;
      }

      if (data.paid) {
        setLastTxHash(data.txHash ?? null);
        await fetchUserData(wallet);
        setScreen("success");
        setTimeout(async () => {
          await fetchTask(wallet);
        }, 1500);
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
  } else if (screen === "not_minipay") {
    body = <OutsideMiniPayPage />;
  } else if (screen === "onboarding") {
    body = wallet ? (
      <OnboardingScreen wallet={wallet} onComplete={handleOnboardingComplete} />
    ) : (
      <LoadingScreen />
    );
  } else if (screen === "landing") {
    body = (
      <InAppLanding
        totalEarned={earnings}
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
              <EarningsBadge totalEarned={earnings} />
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
          totalEarned={earnings}
          rewardSymbol={REWARD_TOKEN_SYMBOL}
          submissionCount={submissionCount}
          explorerUrl={EXPLORER_URL}
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
            Paid {task?.rewardDisplay ?? REWARD_AMOUNT} {task?.rewardSymbol ?? REWARD_TOKEN_SYMBOL}
          </h2>
          <p className="text-center font-body text-sm text-on-surface-variant">
            Your contribution helps improve AI.
            {lastTxHash && (
              <>
                {" "}
                <a
                  href={`${EXPLORER_URL}/tx/${lastTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  View on explorer
                </a>
              </>
            )}
          </p>
          <div className="w-full rounded-3xl bg-surface-container-lowest p-6 shadow-[0_8px_32px_rgba(25,28,30,0.06)]">
            <div className="flex flex-col items-center">
              <span className="mb-2 font-label text-xs font-bold uppercase tracking-widest text-outline">
                Updated Balance
              </span>
              <div className="flex items-baseline gap-1">
                <span className="font-headline text-4xl font-extrabold tracking-tighter text-on-surface">
                  {earnings}
                </span>
                <span className="font-headline text-xl font-bold text-secondary">{REWARD_TOKEN_SYMBOL}</span>
              </div>
            </div>
          </div>
          <SubmitButton label="Next Task" onClick={() => wallet && fetchTask(wallet)} />
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
          <SubmitButton label="Next Task" onClick={() => wallet && fetchTask(wallet)} />
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
          <p className="font-body text-sm text-on-surface-variant">
            We noticed unusually low accuracy on recent tasks. Reach out if you think this is a
            mistake.
          </p>
          <a href="mailto:support@centient.work" className="text-sm text-primary underline">
            support@centient.work
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
            <EarningsBadge totalEarned={earnings} />
          </div>
        </div>
      </div>
    );
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
            Couldn&apos;t connect to MiniPay
          </h2>
          <p className="font-body text-sm text-on-surface-variant">
            Open the app from MiniPay or try again.
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