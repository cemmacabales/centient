"use client";

import { useCallback, useEffect, useState } from "react";
import { isMiniPay, getWalletAddress } from "@/lib/minipay";
import TaskCard from "@/components/TaskCard";
import EarningsBadge from "@/components/EarningsBadge";
import SubmitButton from "@/components/SubmitButton";
import LoadingScreen from "@/components/LoadingScreen";
import { REWARD_AMOUNT, REWARD_TOKEN_SYMBOL } from "@/lib/constants";

type Screen =
  | "checking"
  | "not_minipay"
  | "loading"
  | "task"
  | "no_tasks"
  | "success"
  | "quality_failed"
  | "banned";

interface TaskData {
  id: string;
  prompt: string;
  responseA: string;
  responseB: string;
}

const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://celoscan.io";

export default function Home() {
  const [screen, setScreen] = useState<Screen>("checking");
  const [wallet, setWallet] = useState<string | null>(null);
  const [task, setTask] = useState<TaskData | null>(null);
  const [earnings, setEarnings] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  const fetchUserData = useCallback(async (addr: string) => {
    const res = await fetch(`/api/me?wallet=${addr}`);
    const data = await res.json();
    setEarnings(data.totalEarned ?? "0");
  }, []);

  const fetchTask = useCallback(async (addr: string) => {
    const res = await fetch(`/api/task?wallet=${addr}`);
    const data = await res.json();
    if (data.task) {
      setTask(data.task);
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
    getWalletAddress().then(async (addr) => {
      if (!addr) {
        setScreen("not_minipay");
        return;
      }
      setWallet(addr);
      await fetchUserData(addr);
      await fetchTask(addr);
    });
  }, [fetchUserData, fetchTask]);

  async function handleSubmit(choice: "A" | "B", reason: string) {
    if (!wallet || !task) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet, taskId: task.id, choice, reason }),
      });
      const data = await res.json();

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
        setLastTxHash(data.txHash);
        await fetchUserData(wallet);
        setScreen("success");
        setTimeout(async () => {
          await fetchTask(wallet);
        }, 1500);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (screen === "checking" || screen === "loading") {
    return <LoadingScreen />;
  }

  if (screen === "not_minipay") {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="absolute -right-[10%] -top-[20%] h-[80vw] w-[80vw] rounded-full bg-primary/5 blur-[100px]" />
          <div className="absolute -left-[20%] top-[40%] h-[70vw] w-[70vw] rounded-full bg-secondary/5 blur-[80px]" />
        </div>
        <div className="relative z-10 flex max-w-sm flex-col items-center gap-6">
          <h1 className="text-3xl font-headline font-extrabold tracking-tight text-on-surface">
            Centient runs inside MiniPay
          </h1>
          <p className="font-body text-base text-on-surface-variant">Train AI, cent by cent.</p>
          <a
            href="https://minipay.to"
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-14 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-primary to-primary-container font-label text-lg font-bold text-white shadow-[0_8px_24px_rgba(0,109,61,0.2)] transition-transform duration-200 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            Get MiniPay
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              arrow_forward
            </span>
          </a>
          <p className="text-xs font-label font-bold uppercase tracking-[0.2em] text-outline">
            centient.work
          </p>
        </div>
      </div>
    );
  }

  if (screen === "task" && task) {
    return (
      <div className="min-h-screen bg-surface">
        <header className="sticky top-0 z-40 flex w-full items-center justify-between bg-surface-container-low px-6 py-4">
          <div className="flex items-center gap-3">
            <span
              className="material-symbols-outlined text-primary"
              style={{ fontVariationSettings: "'FILL' 1" }}
              aria-hidden="true"
            >
              account_balance_wallet
            </span>
            <span className="text-xl font-headline font-extrabold tracking-tighter text-primary">
              Centient
            </span>
          </div>
          <EarningsBadge totalEarned={earnings} />
        </header>
        <main className="mx-auto max-w-lg px-4 py-6">
          <TaskCard task={task} onSubmit={handleSubmit} loading={submitting} />
        </main>
      </div>
    );
  }

  if (screen === "success") {
    return (
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
            Paid {REWARD_AMOUNT} {REWARD_TOKEN_SYMBOL}
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
  }

  if (screen === "quality_failed") {
    return (
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
  }

  if (screen === "banned") {
    return (
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
  }

  if (screen === "no_tasks") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6 text-center">
        <div className="flex w-full max-w-sm flex-col items-center gap-4">
          <h2 className="text-2xl font-headline font-bold text-on-surface">All tasks complete</h2>
          <p className="font-body text-sm text-on-surface-variant">
            Check back soon for more tasks.
          </p>
          <EarningsBadge totalEarned={earnings} />
        </div>
      </div>
    );
  }

  return null;
}
